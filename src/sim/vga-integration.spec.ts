// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026, Tiny Tapeout LTD
// Author: Uri Shaked

/**
 * VGA integration test: compiles a preset, renders the first frame,
 * and compares against a reference PNG image.
 */

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { PNG } from 'pngjs';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { compileVerilator } from '../verilator/compile';
import { HDLModuleWASM } from './hdlwasm';
import {
  detectSyncPolarity,
  renderVGAFrame,
  resetModule,
  skipToFrameBoundary,
  VGA_HEIGHT,
  VGA_WIDTH,
} from './vga';

const __dirname = dirname(fileURLToPath(import.meta.url));
const verilatorWasmBinary = readFileSync(resolve(__dirname, '../verilator/verilator_bin.wasm'));

// Mock process.exit to prevent Verilator from killing the test process
const originalExit = process.exit;
beforeAll(() => {
  process.setMaxListeners(20);
  process.exit = vi.fn((code?: number) => {
    throw new Error(`process.exit called with code ${code}`);
  }) as any;
});

afterAll(() => {
  process.exit = originalExit;
});

function decodePNG(buf: Buffer): { width: number; height: number; data: Uint8Array } {
  const png = PNG.sync.read(buf);
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
}

async function compileAndRenderFrame(sources: Record<string, string>) {
  const res = await compileVerilator({
    topModule: 'tt_um_vga_example',
    sources,
    wasmBinary: verilatorWasmBinary,
  });
  if (!res.output) {
    throw new Error(`Compilation failed: ${res.errors.map((e) => e.message).join('\n')}`);
  }

  const constpool = res.output.modules['@CONST-POOL@'] || res.output.modules['__Vconst'];
  const mod = new HDLModuleWASM(res.output.modules['TOP'], constpool);
  await mod.init();

  resetModule(mod);
  const polarity = detectSyncPolarity(mod);
  // Reset again so the frame counter starts fresh (polarity detection advances the sim)
  resetModule(mod);
  skipToFrameBoundary(mod, polarity);

  const pixels = new Uint8Array(VGA_WIDTH * VGA_HEIGHT * 4);
  renderVGAFrame(mod, pixels, { polarity });
  mod.dispose();

  return { pixels, polarity };
}

const refPath = resolve(__dirname, '../examples/stripes/reference/frame0.png');

describe('VGA Integration', () => {
  test('renders first frame of stripes preset matching reference', async () => {
    const { pixels, polarity } = await compileAndRenderFrame({
      'project.v': readFileSync(resolve(__dirname, '../examples/stripes/project.v'), 'utf8'),
      'hvsync_generator.v': readFileSync(
        resolve(__dirname, '../examples/common/hvsync_generator.v'),
        'utf8',
      ),
    });

    expect(polarity).toEqual({ hsyncActiveLow: true, vsyncActiveLow: true });

    const ref = decodePNG(readFileSync(refPath));
    expect(Buffer.from(pixels).equals(Buffer.from(ref.data))).toBe(true);
  });

  // Backwards compatibility test: verify that active-high sync signals are handled correctly
  test('should render correctly with active-high sync signals', async () => {
    const hvsyncV = readFileSync(
      resolve(__dirname, '../examples/common/hvsync_generator.v'),
      'utf8',
    )
      .replace(
        'hsync <= ~(hpos>=H_SYNC_START && hpos<=H_SYNC_END)',
        'hsync <= (hpos>=H_SYNC_START && hpos<=H_SYNC_END)',
      )
      .replace(
        'vsync <= ~(vpos>=V_SYNC_START && vpos<=V_SYNC_END)',
        'vsync <= (vpos>=V_SYNC_START && vpos<=V_SYNC_END)',
      );

    const { pixels, polarity } = await compileAndRenderFrame({
      'project.v': readFileSync(resolve(__dirname, '../examples/stripes/project.v'), 'utf8'),
      'hvsync_generator.v': hvsyncV,
    });

    expect(polarity).toEqual({ hsyncActiveLow: false, vsyncActiveLow: false });

    // Same reference — only sync polarity changed, pixel data is identical
    const ref = decodePNG(readFileSync(refPath));
    expect(Buffer.from(pixels).equals(Buffer.from(ref.data))).toBe(true);
  });

  // End-to-end smoke test using a real Tiny Tapeout design
  // (johshoff/ttsky-26a, top module tt_um_johshoff_metaballs). We don't
  // ship a reference frame for it — just verify it compiles, simulates
  // through a non-trivial run, and drives a non-zero uo_out (i.e. the
  // VGA pipeline produces something).
  test('johshoff/ttsky-26a metaballs compiles, simulates, and drives uo_out', async () => {
    const fixtureDir = resolve(__dirname, '__fixtures__/johshoff_ttsky26a');
    const res = await compileVerilator({
      topModule: 'tt_um_johshoff_metaballs',
      sources: {
        'project.v': readFileSync(resolve(fixtureDir, 'project.v'), 'utf8'),
        'metaballs.v': readFileSync(resolve(fixtureDir, 'metaballs.v'), 'utf8'),
      },
      wasmBinary: verilatorWasmBinary,
    });
    if (!res.output) {
      throw new Error(`Compilation failed: ${res.errors.map((e) => e.message).join('\n')}`);
    }
    const constpool = res.output.modules['@CONST-POOL@'] || res.output.modules['__Vconst'];
    const mod = new HDLModuleWASM(res.output.modules['TOP'], constpool);
    await mod.init();
    resetModule(mod);

    const uo_out_offset = mod.globals.lookup('uo_out').offset;
    let nonZeroSeen = false;
    const differentValuesSeen = new Set<number>();
    // 800x600 @ 72Hz with a 50 MHz pixel clock means ~52 µs / line. At
    // ~31 ns / tick that's ~1700 ticks per scanline, ~1.1M ticks per
    // frame; 200k ticks gets us through several horizontal periods which
    // is plenty for hsync to pulse and the metaballs pixel-rgb to vary.
    for (let i = 0; i < 200_000; i++) {
      mod.tick2(1);
      const v = mod.data8[uo_out_offset];
      if (v !== 0) nonZeroSeen = true;
      differentValuesSeen.add(v);
    }
    expect(nonZeroSeen).toBe(true);
    // Sanity check: across 200k ticks a working VGA pipeline must drive
    // uo_out through more than just one steady state. Even a sync-only
    // signal toggles, so we expect >= 3 distinct byte values (hsync edges,
    // visible-area fill, etc.).
    expect(differentValuesSeen.size).toBeGreaterThanOrEqual(3);
    mod.dispose();
  }, 60000);
});
