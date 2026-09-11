#!/usr/bin/env node

const path = require('path');
const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

const opts = {
  entryPoints: [path.join(__dirname, '..', 'webview', 'src', 'index.js')],
  bundle: true,
  outfile: path.join(__dirname, '..', 'webview', 'dist', 'panel.js'),
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],

  jsx: 'automatic',
  loader: { '.js': 'jsx' },

  define: { 'process.env.NODE_ENV': '"development"' },

  jsx: 'automatic',
  loader: { '.js': 'jsx', '.jsx': 'jsx' },

  define: { 'process.env.NODE_ENV': '"development"' },

  minify: false,
  sourcemap: false,
  logLevel: 'info',
};

module.exports = { opts };

if (require.main === module) {
(async () => {
  if (watch) {
    const ctx = await esbuild.context(opts);
    await ctx.watch();
    console.log('見張っています（Ctrl+C で終わり）');
    return;
  }
  await esbuild.build(opts);
  const fs = require('fs');

  const stamp = require('./lib/uistamp');
  const mark = `\nwindow.__BUNDLE__ = ${JSON.stringify(stamp.fingerprint())};\n`;
  fs.appendFileSync(opts.outfile, mark);
  const out = fs.readFileSync(opts.outfile, 'utf8');
  console.log(`束ねました: ${opts.outfile}（${out.length} 文字）`);
})().catch((e) => {
  console.error('失敗:', e.message);
  process.exit(1);
});
}
