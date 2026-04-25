import { describe, expect, test } from 'vitest';
import { VerilogXMLParser } from './vxmlparser';

/**
 * Focused unit tests for Verilator-5.x-specific parser behavior. The full
 * end-to-end XML pipeline is exercised by the integration specs; these
 * tests pin down edge cases that V4 didn't surface.
 */
describe('VerilogXMLParser (Verilator 5.x compatibility)', () => {
  test('accepts string-literal <const> nodes without throwing', () => {
    // Verilator 5.x emits scheduler region tags as quoted-string consts:
    //   <const name="&quot;stl&quot;" .../>
    // V4 only ever produced `N'h...` numeric literals, so the V4 parser's
    // parseConstValue() threw on these. This test exercises the smallest
    // possible XML that contains such a const inside a cfunc that we drop
    // wholesale.
    const xml = `<?xml version="1.0" ?>
<verilator_xml>
  <files>
    <file id="a" filename="x.sv" language="1800-2023"/>
  </files>
  <netlist>
    <module name="$root" origName="$root" topModule="1">
      <var loc="a,1,1,1,1" name="clk" dtype_id="1" dir="input" vartype="logic" origName="clk"/>
      <cfunc name="_dump_triggers__act">
        <const loc="a,1,1,1,1" name="&quot;act&quot;" dtype_id="2"/>
      </cfunc>
      <cfunc name="_ctor_var_reset"/>
    </module>
    <typetable>
      <basicdtype id="1" name="logic"/>
      <basicdtype id="2" name="string"/>
    </typetable>
  </netlist>
</verilator_xml>`;
    const parser = new VerilogXMLParser();
    expect(() => parser.parse(xml)).not.toThrow();
  });

  test('aliases the V5 $root top module to TOP for legacy callers', () => {
    const xml = `<?xml version="1.0" ?>
<verilator_xml>
  <files>
    <file id="a" filename="x.sv" language="1800-2023"/>
  </files>
  <netlist>
    <module name="$root" origName="$root" topModule="1">
      <var loc="a,1,1,1,1" name="clk" dtype_id="1" dir="input" vartype="logic" origName="clk"/>
      <cfunc name="_ctor_var_reset"/>
    </module>
    <typetable>
      <basicdtype id="1" name="logic"/>
    </typetable>
  </netlist>
</verilator_xml>`;
    const parser = new VerilogXMLParser();
    parser.parse(xml);
    expect(parser.modules['$root']).toBeDefined();
    expect(parser.modules['TOP']).toBe(parser.modules['$root']);
  });

  test('drops V5 trigger/dump/phase scaffolding cfuncs from module.blocks', () => {
    const xml = `<?xml version="1.0" ?>
<verilator_xml>
  <files>
    <file id="a" filename="x.sv" language="1800-2023"/>
  </files>
  <netlist>
    <module name="$root" origName="$root" topModule="1">
      <var loc="a,1,1,1,1" name="clk" dtype_id="1" dir="input" vartype="logic" origName="clk"/>
      <cfunc name="_dump_triggers__act"/>
      <cfunc name="_eval_phase__act"/>
      <cfunc name="_eval_phase__nba"/>
      <cfunc name="_trigger_anySet__act"/>
      <cfunc name="_eval_static"/>
      <cfunc name="_eval_final"/>
      <cfunc name="_eval_debug_assertions"/>
      <cfunc name="_ctor_var_reset"/>
    </module>
    <typetable>
      <basicdtype id="1" name="logic"/>
    </typetable>
  </netlist>
</verilator_xml>`;
    const parser = new VerilogXMLParser();
    parser.parse(xml);
    const blocks = parser.modules['$root'].blocks;
    const blockNames = blocks.map((b) => b.name);
    for (const dropped of [
      '_dump_triggers__act',
      '_eval_phase__act',
      '_eval_phase__nba',
      '_trigger_anySet__act',
      '_eval_static',
      '_eval_final',
      '_eval_debug_assertions',
    ]) {
      expect(blockNames).not.toContain(dropped);
    }
    // _ctor_var_reset is preserved since powercycle() depends on it.
    expect(blockNames).toContain('_ctor_var_reset');
  });
});
