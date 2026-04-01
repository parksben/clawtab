#!/usr/bin/env node
/**
 * generate_icons.js
 * 使用 Node.js canvas 生成 16/48/128px PNG 图标
 * 用法：node icons/generate_icons.js
 * 依赖：npm install canvas
 */

const fs = require('fs');
const path = require('path');

let createCanvas;
try {
  ({ createCanvas } = require('canvas'));
} catch (e) {
  // 如果没有安装 canvas，使用内嵌的 base64 PNG
  console.log('canvas 模块未安装，使用内嵌 base64 图标代替。');
  console.log('如需生成真实 PNG，请运行：npm install canvas');
  writeBase64Icons();
  process.exit(0);
}

const sizes = [16, 48, 128];
const outDir = path.dirname(__filename);

for (const size of sizes) {
  for (const connected of [false, true]) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');

    // 背景
    const bgColor = connected ? '#22d3ee' : '#64748b';
    ctx.fillStyle = bgColor;
    const r = size * 0.2;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(size - r, 0);
    ctx.quadraticCurveTo(size, 0, size, r);
    ctx.lineTo(size, size - r);
    ctx.quadraticCurveTo(size, size, size - r, size);
    ctx.lineTo(r, size);
    ctx.quadraticCurveTo(0, size, 0, size - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
    ctx.fill();

    // 字母 V
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.floor(size * 0.6)}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('V', size / 2, size / 2 + size * 0.03);

    const suffix = connected ? '_on' : '_off';
    const filename = path.join(outDir, `icon${size}${suffix}.png`);
    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(filename, buffer);
    console.log(`✓ 生成: ${filename}`);
  }
}

console.log('\n所有图标已生成到 icons/ 目录。');

function writeBase64Icons() {
  // 最小 1x1 透明 PNG（placeholder）
  const tiny = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );
  const sizes = [16, 48, 128];
  for (const s of sizes) {
    fs.writeFileSync(path.join(outDir, `icon${s}.png`), tiny);
    console.log(`✓ 写入占位图标: icon${s}.png`);
  }
}
