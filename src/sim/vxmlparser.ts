import {
  HDLAlwaysBlock,
  HDLArrayItem,
  HDLBinop,
  HDLBlock,
  HDLConstant,
  HDLDataType,
  HDLDataTypeObject,
  HDLExpr,
  HDLExtendop,
  HDLFile,
  HDLFuncCall,
  HDLHierarchyDef,
  HDLInstanceDef,
  HDLLogicType,
  HDLModuleDef,
  HDLNativeType,
  HDLPort,
  HDLSensItem,
  HDLSourceLocation,
  HDLSourceObject,
  HDLTriop,
  HDLUnit,
  HDLUnop,
  HDLUnpackArray,
  HDLVariableDef,
  HDLVarRef,
  HDLWhileOp,
  isConstExpr,
  isVarDecl,
} from './hdltypes';
import { parseXMLPoorly, XMLNode } from './xml';

/**
 * Whaa?
 *
 * Each hierarchy takes (uint32[] -> uint32[])
 * - convert to/from js object
 * - JS or WASM
 * - Fixed-size packets
 * - state is another uint32[]
 * Find optimal packing of bits
 * Find clocks
 * Find pivots (reset, state) concat them together
 * Dependency cycles
 * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer
 */

/**
 * Verilator 5.x wraps the body of `_eval_stl` (and similar) in
 *   if (__VstlTriggered[0] & 1) { ...real combinational assigns... }
 * and the trigger is always set when something has changed. We don't model
 * the trigger vector, so we unconditionally execute the inner body. This
 * helper unwraps that single-`<if>` shell, falling back to returning the
 * cfunc body unchanged for anything that doesn't match the expected shape.
 */
function unwrapTriggerGate(blocks: HDLBlock[]): HDLExpr[] {
  const out: HDLExpr[] = [];
  for (const blk of blocks) {
    for (const stmt of blk.exprs) {
      if (
        stmt &&
        (stmt as HDLTriop).op === 'if' &&
        (stmt as HDLTriop).left &&
        ((stmt as HDLTriop).left as HDLBlock).blocktype != null
      ) {
        const thenBlk = (stmt as HDLTriop).left as HDLBlock;
        for (const inner of thenBlk.exprs) out.push(inner);
      } else {
        out.push(stmt);
      }
    }
  }
  return out;
}

export class CompileError extends Error implements HDLSourceObject {
  $loc: HDLSourceLocation;
  constructor($loc: HDLSourceLocation, msg: string) {
    super(msg);
    this.$loc = $loc;
    Object.setPrototypeOf(this, CompileError.prototype);
  }
}

export class VerilogXMLParser implements HDLUnit {
  files: { [id: string]: HDLFile } = {};
  dtypes: { [id: string]: HDLDataType } = {};
  modules: { [id: string]: HDLModuleDef } = {};
  hierarchies: { [id: string]: HDLHierarchyDef } = {};

  cur_node!: XMLNode;
  cur_module!: HDLModuleDef;
  cur_loc!: HDLSourceLocation;
  cur_loc_str!: string;
  cur_deferred: Array<() => void> = [];

  constructor() {
    // TODO: other types?
    this.dtypes['QData'] = { left: 63, right: 0, signed: false };
    this.dtypes['IData'] = { left: 31, right: 0, signed: false };
    this.dtypes['SData'] = { left: 15, right: 0, signed: false };
    this.dtypes['CData'] = { left: 7, right: 0, signed: false };
    this.dtypes['byte'] = { left: 7, right: 0, signed: true };
    this.dtypes['shortint'] = { left: 15, right: 0, signed: true };
    this.dtypes['int'] = { left: 31, right: 0, signed: true };
    this.dtypes['integer'] = { left: 31, right: 0, signed: true };
    this.dtypes['longint'] = { left: 63, right: 0, signed: true };
    this.dtypes['time'] = { left: 63, right: 0, signed: false };
  }

  defer(fn: () => void) {
    this.cur_deferred.unshift(fn);
  }

  defer2(fn: () => void) {
    this.cur_deferred.push(fn);
  }

  run_deferred() {
    this.cur_deferred.forEach((fn) => fn());
    this.cur_deferred = [];
  }

  name2js(s: string) {
    if (s == null) throw new CompileError(this.cur_loc, `no name`);
    return s.replace(/[^a-z0-9_]/gi, '$');
  }

  findChildren(node: XMLNode, type: string, required: boolean): XMLNode[] {
    const arr = node.children.filter((n) => n.type == type);
    if (arr.length == 0 && required)
      throw new CompileError(this.cur_loc, `no child of type ${type}`);
    return arr;
  }

  parseSourceLocation(node: XMLNode): HDLSourceLocation | undefined {
    const loc = node.attrs['loc'];
    if (loc) {
      if (loc == this.cur_loc_str) {
        return this.cur_loc; // cache last parsed $loc object
      } else {
        const [fileid, line, col, end_line, end_col] = loc.split(',');
        const $loc = {
          hdlfile: this.files[fileid],
          path: this.files[fileid].filename,
          line: parseInt(line),
          start: parseInt(col) - 1,
          end_line: parseInt(end_line),
          end: parseInt(end_col) - 1,
        };
        this.cur_loc = $loc;
        this.cur_loc_str = loc;
        return $loc;
      }
    } else {
      return undefined;
    }
  }

  open_module(node: XMLNode) {
    const module: HDLModuleDef = {
      $loc: this.parseSourceLocation(node),
      name: node.attrs['name'],
      origName: node.attrs['origName'],
      blocks: [],
      instances: [],
      vardefs: {},
    };
    if (this.cur_module) throw new CompileError(this.cur_loc, `nested modules not supported`);
    this.cur_module = module;
    return module;
  }

  deferDataType(node: XMLNode, def: HDLDataTypeObject) {
    const dtype_id = node.attrs['dtype_id'];
    if (dtype_id != null) {
      this.defer(() => {
        def.dtype = this.dtypes[dtype_id];
        if (!def.dtype) {
          throw new CompileError(this.cur_loc, `Unknown data type ${dtype_id} for ${node.type}`);
        }
      });
    }
  }

  parseConstValue(s: string): { value: number | bigint; origWidth: number } {
    // Match constants like 32'hABCD or 512'h0000_1234_... (with optional underscores)
    const re_const = /(\d+)'([s]?)h([0-9a-f_]+)/i;
    const m = re_const.exec(s);
    if (m) {
      const origWidth = parseInt(m[1]);
      // Remove underscores from hex string
      const numstr = m[3].replace(/_/g, '');
      if (numstr.length <= 8) return { value: parseInt(numstr, 16), origWidth };
      else return { value: BigInt('0x' + numstr), origWidth };
    } else if (s.startsWith('"') && s.endsWith('"')) {
      // Verilator 5.x emits string-literal const nodes (e.g. region tags
      // "stl"/"act"/"nba"/"ico") inside scheduler scaffolding cfuncs that we
      // ultimately drop. Represent them as a zero-valued placeholder so the
      // parser can succeed; any code path that actually reaches a string
      // const at runtime is a bug we want to surface elsewhere.
      return { value: 0, origWidth: 0 };
    } else {
      throw new CompileError(this.cur_loc, `could not parse constant "${s}"`);
    }
  }

  resolveVar(s: string, mod: HDLModuleDef): HDLVariableDef {
    const def = mod.vardefs[s];
    if (def == null) throw new CompileError(this.cur_loc, `could not resolve variable "${s}"`);
    return def;
  }

  resolveModule(s: string): HDLModuleDef {
    const mod = this.modules[s];
    if (mod == null) throw new CompileError(this.cur_loc, `could not resolve module "${s}"`);
    return mod;
  }

  //

  visit_verilator_xml(node: XMLNode) {}

  visit_package(node: XMLNode) {
    // TODO?
  }

  visit_module(node: XMLNode) {
    this.findChildren(node, 'var', false).forEach((n) => {
      if (isVarDecl(n.obj)) {
        this.cur_module.vardefs[n.obj.name] = n.obj;
      }
    });
    // Verilator 5.x: bridge the multi-region scheduler to the V4-shape that
    // hdlwasm expects (_eval_initial / _eval_settle / _eval / _change_request).
    this.finalizeV5Scheduler();
    this.modules[this.cur_module.name] = this.cur_module;
    // Verilator 5.x emits a single flat module called `$root` (SystemVerilog
    // top-level package). Older code (and the test suite) keys lookups by
    // `TOP`, the name V4 used. Register an alias so callers don't need to
    // care which Verilator we ran.
    if (
      this.cur_module.name === '$root' &&
      node.attrs['topModule'] === '1' &&
      !this.modules['TOP']
    ) {
      this.modules['TOP'] = this.cur_module;
    }
    this.cur_module = null!;
  }

  /**
   * If we just parsed a Verilator 5.x module, manufacture the V4-style top-
   * level cfuncs out of the V5 sequent/settle bodies. A no-op for inputs that
   * already had their _eval/_eval_settle visited (V4 fallback).
   */
  private finalizeV5Scheduler() {
    const mod = this.cur_module;
    if (!mod) return;
    const blocks = mod.blocks;
    // Collect blocks by name; some names (the sequent ones) are unique per
    // generated body and there can be several.
    const named = new Map<string, HDLBlock[]>();
    for (const b of blocks) {
      if (!b.name) continue;
      const list = named.get(b.name) ?? [];
      list.push(b);
      named.set(b.name, list);
    }
    const has = (n: string) => named.has(n);
    // Heuristic: V5 always emits _eval_stl. If absent, the input is V4 (or a
    // module so trivial Verilator emitted nothing) — leave the blocks alone.
    const stlBlocks = named.get('_eval_stl') ?? [];
    const icoBlocks: HDLBlock[] = [];
    const nbaBlocks: HDLBlock[] = [];
    for (const b of blocks) {
      if (b.name && b.name.startsWith('_ico_sequent__')) icoBlocks.push(b);
      if (b.name && b.name.startsWith('_nba_sequent__')) nbaBlocks.push(b);
    }
    // Detect V5 by checking for any of the scheduler cfuncs (we know V4 had
    // _eval_settle with the actual body, not as an empty marker).
    const hasV5Scheduler = stlBlocks.length > 0 || icoBlocks.length > 0 || nbaBlocks.length > 0;
    if (!hasV5Scheduler) {
      return; // Looks like V4 XML.
    }
    const mkBlock = (name: string, exprs: HDLExpr[]): HDLBlock => ({
      blocktype: 'cfunc',
      name,
      exprs,
    });
    // _eval_stl bodies are wrapped in `if (__VstlTriggered[0])`. We don't
    // gate, we just always run the inner bodies — the simulator only invokes
    // _eval_settle/_eval when something has changed, and the bodies are pure
    // combinational assigns. Note `_eval_stl` may itself contain `<ccall>`s
    // to outlined combo functions like `_ico_sequent__TOP__0`; we leave
    // those callees defined as ordinary cfuncs.
    const stlBody = unwrapTriggerGate(stlBlocks);
    // Build ccalls to the kept _nba_sequent__* cfuncs (rather than inlining
    // their bodies) so that any local `<var>`s declared inside them stay
    // properly scoped to those functions.
    const nbaSequentCalls: HDLExpr[] = nbaBlocks.map(
      (b) =>
        ({
          funcname: b.name,
          dtype: null!,
          args: [],
        }) as HDLFuncCall,
    );
    // Same for _ico_sequent__* — call them at startup.
    const icoSequentCalls: HDLExpr[] = icoBlocks.map(
      (b) =>
        ({
          funcname: b.name,
          dtype: null!,
          args: [],
        }) as HDLFuncCall,
    );
    // Drop only `_eval_stl` itself — its body has been hoisted into our
    // synthesized cfuncs. `_ico_sequent__*` and `_nba_sequent__*` stay as
    // callable functions referenced by ccalls in the inlined body.
    const consumed = new Set<string>(['_eval_stl']);
    mod.blocks = blocks.filter((b) => !b.name || !consumed.has(b.name));
    // Posedge-clk gate: V5 wires _nba_sequent__* through __VnbaTriggered, which
    // is set when `clk && !__Vtrigprevexpr_clk`. Reproduce that here so we
    // execute non-blocking assigns on the rising edge of clk only. If the
    // design has no clk, the trigger var is absent and we just always execute
    // the nba bodies (no-op for pure combo).
    //
    // dtype lookups against vardefs are still pending at this point (they
    // run via `defer()` after parsing). Defer the gate construction so the
    // synthesized varrefs see the real types.
    const clkPrev = this.findClkTriggerPrevVar(mod);
    let evalNbaStmts: HDLExpr[] = nbaSequentCalls;
    if (nbaSequentCalls.length > 0 && clkPrev) {
      // Placeholders we'll mutate via defer().
      const clkRef: HDLVarRef = { refname: 'clk', dtype: null! };
      const prevRef: HDLVarRef = { refname: clkPrev, dtype: null! };
      const notNode: HDLUnop = { op: 'not', dtype: null!, left: prevRef };
      const cond: HDLBinop = { op: 'and', dtype: null!, left: clkRef, right: notNode };
      const updatePrev: HDLBinop = {
        op: 'assign',
        dtype: null!,
        // V5/V4 convention: <assign> child[0]=src, child[1]=dest, so
        // `left=clk` (src) and `right=prev` (dest).
        left: clkRef,
        right: prevRef,
      };
      // defer2 runs AFTER the deferDataType() calls registered via defer(),
      // so by the time we sample mod.vardefs[*].dtype it is populated.
      this.defer2(() => {
        clkRef.dtype = mod.vardefs['clk'].dtype;
        prevRef.dtype = mod.vardefs[clkPrev].dtype;
        notNode.dtype = prevRef.dtype;
        cond.dtype = clkRef.dtype;
        updatePrev.dtype = clkRef.dtype;
      });
      const ifBlock: HDLTriop = {
        op: 'if',
        dtype: null!,
        cond,
        left: mkBlock(null!, [...nbaSequentCalls]),
        right: null!,
      };
      // Update the prev tracker UNCONDITIONALLY at the end (after firing the
      // body), to mirror Verilator's `_eval_triggers__act` which always
      // assigns `prev = clk` regardless of whether the edge fired. Without
      // this the prev tracker would only update on rising edges and a
      // subsequent rising edge (after a fall) would never re-fire.
      evalNbaStmts = [ifBlock as unknown as HDLExpr, updatePrev as unknown as HDLExpr];
    }
    // _eval_initial: combo settle on the very first call (so outputs reflect
    // input values before clocks tick). _eval_settle: also combo. _eval:
    // combo + posedge nba + combo (so flop outputs propagate combinationally
    // before the next eval).
    // We always synthesize V4-shaped top-level cfuncs for V5 inputs, even if
    // `_eval_initial`/etc. existed in the V5 XML — the V5 versions reference
    // scheduler bookkeeping we've torn out.
    mod.blocks = mod.blocks.filter(
      (b) =>
        b.name !== '_eval_initial' &&
        b.name !== '_eval_settle' &&
        b.name !== '_eval' &&
        b.name !== '_change_request',
    );
    mod.blocks.push(mkBlock('_eval_initial', [...icoSequentCalls, ...stlBody]));
    mod.blocks.push(mkBlock('_eval_settle', [...stlBody]));
    mod.blocks.push(mkBlock('_eval', [...stlBody, ...evalNbaStmts, ...stlBody]));
    mod.blocks.push(mkBlock('_change_request', []));
  }

  /**
   * Search the module's vardefs for the prev-clk tracker emitted by
   * Verilator 5.x. Naming convention: `__Vtrigprevexpr___TOP__clk__N`.
   */
  private findClkTriggerPrevVar(mod: HDLModuleDef): string | null {
    for (const name of Object.keys(mod.vardefs)) {
      if (name.startsWith('__Vtrigprevexpr_') && name.includes('clk')) {
        return name;
      }
    }
    return null;
  }

  visit_var(node: XMLNode): HDLVariableDef {
    let name = node.attrs['name'];
    name = this.name2js(name);
    const vardef: HDLVariableDef = {
      $loc: this.parseSourceLocation(node),
      name: name,
      origName: node.attrs['origName'],
      isInput: node.attrs['dir'] == 'input',
      isOutput: node.attrs['dir'] == 'output',
      isParam: node.attrs['param'] == 'true',
      dtype: null!,
    };
    this.deferDataType(node, vardef);
    const const_nodes = this.findChildren(node, 'const', false);
    if (const_nodes.length) {
      vardef.constValue = const_nodes[0].obj;
    }
    const init_nodes = this.findChildren(node, 'initarray', false);
    if (init_nodes.length) {
      vardef.initValue = init_nodes[0].obj;
    }
    return vardef;
  }

  visit_const(node: XMLNode): HDLConstant {
    const name = node.attrs['name'];
    const { value, origWidth } = this.parseConstValue(name);
    const constdef: HDLConstant = {
      $loc: this.parseSourceLocation(node),
      dtype: null!,
      cvalue: typeof value === 'number' ? value : null!,
      bigvalue: typeof value === 'bigint' ? value : null!,
      origWidth,
    };
    this.deferDataType(node, constdef);
    return constdef;
  }

  visit_varref(node: XMLNode): HDLVarRef {
    let name = node.attrs['name'];
    name = this.name2js(name);
    const varref: HDLVarRef = {
      $loc: this.parseSourceLocation(node),
      dtype: null!,
      refname: name,
    };
    this.deferDataType(node, varref);
    const mod = this.cur_module;
    /*
        this.defer2(() => {
            varref.vardef = this.resolveVar(name, mod);
        });
        */
    return varref;
  }

  visit_sentree(node: XMLNode) {
    // TODO
  }

  visit_always(node: XMLNode): HDLAlwaysBlock {
    // TODO
    let sentree: HDLSensItem[] | null;
    let expr: HDLExpr;
    if (node.children.length == 2) {
      sentree = node.children[0].obj as HDLSensItem[];
      expr = node.children[1].obj as HDLExpr;
      // TODO: check sentree
    } else {
      sentree = null;
      expr = node.children[0].obj as HDLExpr;
    }
    const always: HDLAlwaysBlock = {
      $loc: this.parseSourceLocation(node),
      blocktype: node.type,
      name: null!,
      senlist: sentree!,
      exprs: [expr],
    };
    this.cur_module.blocks.push(always);
    return always;
  }

  visit_begin(node: XMLNode): HDLBlock {
    const exprs: HDLExpr[] = [];
    node.children.forEach((n) => exprs.push(n.obj));
    return {
      $loc: this.parseSourceLocation(node),
      blocktype: node.type,
      name: node.attrs['name'],
      exprs: exprs,
    };
  }

  visit_initarray(node: XMLNode): HDLBlock {
    return this.visit_begin(node);
  }

  visit_inititem(node: XMLNode): HDLArrayItem {
    this.expectChildren(node, 1, 1);
    return {
      index: parseInt(node.attrs['index']),
      expr: node.children[0].obj,
    };
  }

  visit_cfunc(node: XMLNode) {
    if (this.cur_module == null) {
      return;
    }
    const block = this.visit_begin(node);
    block.exprs = [];
    node.children.forEach((n) => block.exprs.push(n.obj));
    const name = block.name;
    // Verilator 5.x: drop scheduler scaffolding and debug helpers wholesale.
    // We synthesize equivalents (when needed) in finalizeV5Scheduler() once
    // the module has finished parsing.
    if (this.isV5SchedulerCfunc(name)) {
      return block;
    }
    this.cur_module.blocks.push(block);
    return block;
  }

  /**
   * V5 cfuncs we drop unconditionally. The "real" combinational and
   * non-blocking-assignment bodies live in `_eval_stl`, `_ico_sequent__*`,
   * and `_nba_sequent__*` — those we keep.
   */
  private isV5SchedulerCfunc(name: string): boolean {
    if (name == null) return false;
    return (
      name === '_eval_static' ||
      name === '_eval_initial' ||
      name === '_eval_final' ||
      name === '_eval_settle' ||
      name === '_eval_ico' ||
      name === '_eval_nba' ||
      name === '_eval' ||
      name === '_eval_debug_assertions' ||
      name.startsWith('_eval_phase__') ||
      name.startsWith('_eval_triggers__') ||
      name.startsWith('_dump_triggers__') ||
      name.startsWith('_trigger_anySet__') ||
      name.startsWith('_trigger_orInto__') ||
      name.startsWith('_trigger_clear__')
    );
  }

  visit_cuse(node: XMLNode) {
    // TODO?
  }

  visit_instance(node: XMLNode): HDLInstanceDef {
    const instance: HDLInstanceDef = {
      $loc: this.parseSourceLocation(node),
      name: node.attrs['name'],
      origName: node.attrs['origName'],
      ports: [],
      module: null!,
    };
    node.children.forEach((child) => {
      instance.ports.push(child.obj);
    });
    this.cur_module.instances.push(instance);
    this.defer(() => {
      instance.module = this.resolveModule(node.attrs['defName']);
    });
    return instance;
  }

  visit_iface(node: XMLNode) {
    throw new CompileError(this.cur_loc, `interfaces not supported`);
  }

  visit_intfref(node: XMLNode) {
    throw new CompileError(this.cur_loc, `interfaces not supported`);
  }

  visit_port(node: XMLNode): HDLPort {
    this.expectChildren(node, 1, 1);
    const varref: HDLPort = {
      $loc: this.parseSourceLocation(node),
      name: node.attrs['name'],
      expr: node.children[0].obj,
    };
    return varref;
  }

  visit_netlist(node: XMLNode) {}

  visit_files(node: XMLNode) {}

  visit_module_files(node: XMLNode) {
    node.children.forEach((n) => {
      if (n.obj) {
        const file = this.files[(n.obj as HDLFile).id];
        if (file) file.isModule = true;
      }
    });
  }

  visit_file(node: XMLNode) {
    return this.visit_file_or_module(node, false);
  }

  // TODO
  visit_scope(node: XMLNode) {}

  visit_topscope(node: XMLNode) {}

  visit_file_or_module(node: XMLNode, isModule: boolean): HDLFile {
    const file: HDLFile = {
      id: node.attrs['id'],
      filename: node.attrs['filename'],
      isModule: isModule,
    };
    this.files[file.id] = file;
    return file;
  }

  visit_cells(node: XMLNode) {
    this.expectChildren(node, 1, 9999);
    const hier = node.children[0].obj as HDLHierarchyDef;
    if (hier != null) {
      const hiername = hier.name;
      this.hierarchies[hiername] = hier;
    }
  }

  visit_cell(node: XMLNode): HDLHierarchyDef {
    const hier: HDLHierarchyDef = {
      $loc: this.parseSourceLocation(node),
      name: node.attrs['name'],
      module: null!,
      parent: null!,
      children: node.children.map((n) => n.obj),
    };
    if (node.children.length > 0)
      throw new CompileError(this.cur_loc, `multiple non-flattened modules not yet supported`);
    node.children.forEach((n) => ((n.obj as HDLHierarchyDef).parent = hier));
    this.defer(() => {
      hier.module = this.resolveModule(node.attrs['submodname']);
    });
    return hier;
  }

  visit_basicdtype(node: XMLNode): HDLDataType {
    let id = node.attrs['id'];
    let dtype: HDLDataType;
    const dtypename = node.attrs['name'];
    switch (dtypename) {
      case 'logic':
      case 'integer': // TODO?
      case 'bit':
        let dlogic: HDLLogicType = {
          $loc: this.parseSourceLocation(node),
          left: parseInt(node.attrs['left'] || '0'),
          right: parseInt(node.attrs['right'] || '0'),
          signed: node.attrs['signed'] == 'true',
        };
        dtype = dlogic;
        break;
      case 'string':
        let dstring: HDLNativeType = {
          $loc: this.parseSourceLocation(node),
          jstype: 'string',
        };
        dtype = dstring;
        break;
      default:
        dtype = this.dtypes[dtypename];
        if (dtype == null) {
          throw new CompileError(this.cur_loc, `unknown data type ${dtypename}`);
        }
    }
    this.dtypes[id] = dtype;
    return dtype;
  }

  visit_refdtype(node: XMLNode) {}

  visit_enumdtype(node: XMLNode) {}

  visit_enumitem(node: XMLNode) {}

  visit_packarraydtype(node: XMLNode): HDLDataType {
    // TODO: packed?
    return this.visit_unpackarraydtype(node);
  }

  visit_memberdtype(node: XMLNode) {
    throw new CompileError(null!, `structs not supported`);
  }

  visit_constdtype(node: XMLNode) {
    // TODO? throw new CompileError(null, `constant data types not supported`);
  }

  visit_paramtypedtype(node: XMLNode) {
    // TODO? throw new CompileError(null, `constant data types not supported`);
  }

  visit_unpackarraydtype(node: XMLNode): HDLDataType {
    let id = node.attrs['id'];
    let sub_dtype_id = node.attrs['sub_dtype_id'];
    let range = node.children[0].obj as HDLBinop;
    if (isConstExpr(range.left) && isConstExpr(range.right)) {
      const dtype: HDLUnpackArray = {
        $loc: this.parseSourceLocation(node),
        subtype: null!,
        low: range.left,
        high: range.right,
      };
      this.dtypes[id] = dtype;
      this.defer(() => {
        dtype.subtype = this.dtypes[sub_dtype_id];
        if (!dtype.subtype)
          throw new CompileError(this.cur_loc, `Unknown data type ${sub_dtype_id} for array`);
      });
      return dtype;
    } else {
      throw new CompileError(this.cur_loc, `could not parse constant exprs in array`);
    }
  }

  visit_senitem(node: XMLNode): HDLSensItem {
    const edgeType = node.attrs['edgeType'];
    if (edgeType != 'POS' && edgeType != 'NEG')
      throw new CompileError(this.cur_loc, 'POS/NEG required');
    return {
      $loc: this.parseSourceLocation(node),
      edgeType: edgeType,
      expr: node.obj,
    };
  }

  visit_text(node: XMLNode) {}

  visit_cstmt(node: XMLNode) {
    // Verilator 5.x: a wrapper around debug-print statements (mostly <text>
    // nodes plus the occasional varref). Treat as a no-op block.
    return null;
  }

  visit_stmtexpr(node: XMLNode) {
    // Verilator 5.x: wraps a statement expression (typically a single
    // <ccall>). Unwrap to its single child so block emission treats the call
    // as a top-level statement.
    if (node.children.length === 1) return node.children[0].obj;
    return {
      $loc: this.parseSourceLocation(node),
      blocktype: 'block',
      name: null!,
      exprs: node.children.map((n) => n.obj),
    } as HDLBlock;
  }

  visit_loop(node: XMLNode) {
    // Verilator 5.x: emitted only inside scheduler scaffolding cfuncs that
    // are filtered out by skipScheduler() before code generation. Return null
    // so that if any leak through they no-op rather than crashing the
    // compiler down the line.
    return null;
  }

  visit_looptest(node: XMLNode) {
    // Verilator 5.x: companion of <loop>; same rationale as above.
    return null;
  }

  visit_voiddtype(node: XMLNode): HDLDataType {
    // Verilator 5.x emits <voiddtype> for cfuncs returning void / for the
    // `tag` parameter type of debug helpers we drop. Register a placeholder
    // logic dtype so dtype_id lookups still succeed for any expressions that
    // reference it but never actually code-gen.
    const id = node.attrs['id'];
    const dtype: HDLLogicType = {
      $loc: this.parseSourceLocation(node),
      left: 0,
      right: 0,
      signed: false,
    };
    this.dtypes[id] = dtype;
    return dtype;
  }

  visit_cfile(node: XMLNode) {}

  visit_typetable(node: XMLNode) {}

  visit_constpool(node: XMLNode) {}

  visit_comment(node: XMLNode) {}

  expectChildren(node: XMLNode, low: number, high: number) {
    if (node.children.length < low || node.children.length > high)
      throw new CompileError(this.cur_loc, `expected between ${low} and ${high} children`);
  }

  __visit_unop(node: XMLNode): HDLUnop {
    this.expectChildren(node, 1, 1);
    const expr: HDLUnop = {
      $loc: this.parseSourceLocation(node),
      op: node.type,
      dtype: null!,
      left: node.children[0].obj as HDLExpr,
    };
    this.deferDataType(node, expr);
    return expr;
  }

  visit_extend(node: XMLNode): HDLUnop {
    const unop = this.__visit_unop(node) as HDLExtendop;
    unop.width = parseInt(node.attrs['width']);
    unop.widthminv = parseInt(node.attrs['widthminv']);
    return unop;
  }

  visit_extends(node: XMLNode): HDLUnop {
    return this.visit_extend(node);
  }

  __visit_binop(node: XMLNode): HDLBinop {
    this.expectChildren(node, 2, 2);
    const expr: HDLBinop = {
      $loc: this.parseSourceLocation(node),
      op: node.type,
      dtype: null!,
      left: node.children[0].obj as HDLExpr,
      right: node.children[1].obj as HDLExpr,
    };
    this.deferDataType(node, expr);
    return expr;
  }

  visit_if(node: XMLNode): HDLTriop {
    this.expectChildren(node, 2, 3);
    const expr: HDLTriop = {
      $loc: this.parseSourceLocation(node),
      op: 'if',
      dtype: null!,
      cond: node.children[0].obj as HDLExpr,
      left: node.children[1].obj as HDLExpr,
      right: node.children[2] && (node.children[2].obj as HDLExpr),
    };
    return expr;
  }

  // while and for loops
  visit_while(node: XMLNode): HDLWhileOp {
    this.expectChildren(node, 2, 4);
    const expr: HDLWhileOp = {
      $loc: this.parseSourceLocation(node),
      op: 'while',
      dtype: null!,
      precond: node.children[0].obj as HDLExpr,
      loopcond: node.children[1].obj as HDLExpr,
      body: node.children[2] && (node.children[2].obj as HDLExpr),
      inc: node.children[3] && (node.children[3].obj as HDLExpr),
    };
    return expr;
  }

  __visit_triop(node: XMLNode): HDLBinop {
    this.expectChildren(node, 3, 3);
    const expr: HDLTriop = {
      $loc: this.parseSourceLocation(node),
      op: node.type,
      dtype: null!,
      cond: node.children[0].obj as HDLExpr,
      left: node.children[1].obj as HDLExpr,
      right: node.children[2].obj as HDLExpr,
    };
    this.deferDataType(node, expr);
    return expr;
  }

  __visit_func(node: XMLNode): HDLFuncCall {
    const expr: HDLFuncCall = {
      $loc: this.parseSourceLocation(node),
      dtype: null!,
      funcname: node.attrs['func'] || '$' + node.type,
      args: node.children.map((n) => n.obj as HDLExpr),
    };
    this.deferDataType(node, expr);
    return expr;
  }

  visit_not(node: XMLNode) {
    return this.__visit_unop(node);
  }
  visit_negate(node: XMLNode) {
    return this.__visit_unop(node);
  }
  visit_redand(node: XMLNode) {
    return this.__visit_unop(node);
  }
  visit_redor(node: XMLNode) {
    return this.__visit_unop(node);
  }
  visit_redxor(node: XMLNode) {
    return this.__visit_unop(node);
  }
  visit_initial(node: XMLNode) {
    return this.__visit_unop(node);
  }
  visit_ccast(node: XMLNode) {
    return this.__visit_unop(node);
  }
  visit_creset(node: XMLNode) {
    return this.__visit_unop(node);
  }
  visit_creturn(node: XMLNode) {
    return this.__visit_unop(node);
  }

  visit_contassign(node: XMLNode) {
    return this.__visit_binop(node);
  }
  visit_assigndly(node: XMLNode) {
    return this.__visit_binop(node);
  }
  visit_assignpre(node: XMLNode) {
    return this.__visit_binop(node);
  }
  visit_assignpost(node: XMLNode) {
    return this.__visit_binop(node);
  }
  visit_assign(node: XMLNode) {
    return this.__visit_binop(node);
  }
  visit_arraysel(node: XMLNode) {
    return this.__visit_binop(node);
  }
  visit_wordsel(node: XMLNode) {
    return this.__visit_binop(node);
  }

  visit_eq(node: XMLNode) {
    return this.__visit_binop(node);
  }
  visit_neq(node: XMLNode) {
    return this.__visit_binop(node);
  }
  visit_lte(node: XMLNode) {
    return this.__visit_binop(node);
  }
  visit_gte(node: XMLNode) {
    return this.__visit_binop(node);
  }
  visit_lt(node: XMLNode) {
    return this.__visit_binop(node);
  }
  visit_gt(node: XMLNode) {
    return this.__visit_binop(node);
  }
  visit_and(node: XMLNode) {
    return this.__visit_binop(node);
  }
  visit_or(node: XMLNode) {
    return this.__visit_binop(node);
  }
  visit_xor(node: XMLNode) {
    return this.__visit_binop(node);
  }
  visit_add(node: XMLNode) {
    return this.__visit_binop(node);
  }
  visit_sub(node: XMLNode) {
    return this.__visit_binop(node);
  }
  visit_concat(node: XMLNode) {
    return this.__visit_binop(node);
  } // TODO?
  visit_shiftl(node: XMLNode) {
    return this.__visit_binop(node);
  }
  visit_shiftr(node: XMLNode) {
    return this.__visit_binop(node);
  }
  visit_shiftrs(node: XMLNode) {
    return this.__visit_binop(node);
  }

  visit_mul(node: XMLNode) {
    return this.__visit_binop(node);
  }
  visit_div(node: XMLNode) {
    return this.__visit_binop(node);
  }
  visit_moddiv(node: XMLNode) {
    return this.__visit_binop(node);
  }
  visit_muls(node: XMLNode) {
    return this.__visit_binop(node);
  }
  visit_divs(node: XMLNode) {
    return this.__visit_binop(node);
  }
  visit_moddivs(node: XMLNode) {
    return this.__visit_binop(node);
  }
  visit_gts(node: XMLNode) {
    return this.__visit_binop(node);
  }
  visit_lts(node: XMLNode) {
    return this.__visit_binop(node);
  }
  visit_gtes(node: XMLNode) {
    return this.__visit_binop(node);
  }
  visit_ltes(node: XMLNode) {
    return this.__visit_binop(node);
  }
  // TODO: more?

  visit_range(node: XMLNode) {
    return this.__visit_binop(node);
  }

  visit_cond(node: XMLNode) {
    return this.__visit_triop(node);
  }
  visit_condbound(node: XMLNode) {
    return this.__visit_triop(node);
  }
  visit_sel(node: XMLNode) {
    return this.__visit_triop(node);
  }

  visit_changedet(node: XMLNode) {
    if (node.children.length == 0) return null;
    else return this.__visit_binop(node);
  }

  visit_ccall(node: XMLNode) {
    return this.__visit_func(node);
  }
  visit_finish(node: XMLNode) {
    return this.__visit_func(node);
  }
  visit_stop(node: XMLNode) {
    return this.__visit_func(node);
  }
  visit_rand(node: XMLNode) {
    return this.__visit_func(node);
  }
  visit_time(node: XMLNode) {
    return this.__visit_func(node);
  }

  visit_display(node: XMLNode) {
    return null;
  }
  visit_sformatf(node: XMLNode) {
    return null;
  }
  visit_scopename(node: XMLNode) {
    return null;
  }

  visit_readmem(node: XMLNode) {
    return this.__visit_func(node);
  }

  //

  xml_open(node: XMLNode) {
    this.cur_node = node;
    const method = (this as any)[`open_${node.type}`];
    if (method) {
      return method.bind(this)(node);
    }
  }

  xml_close(node: XMLNode) {
    this.cur_node = node;
    const method = (this as any)[`visit_${node.type}`];
    if (method) {
      return method.bind(this)(node);
    } else {
      throw new CompileError(this.cur_loc, `no visitor for ${node.type}`);
    }
  }

  parse(xmls: string) {
    parseXMLPoorly(xmls, this.xml_open.bind(this), this.xml_close.bind(this));
    this.cur_node = null!;
    this.run_deferred();
  }
}
