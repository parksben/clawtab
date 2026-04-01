/**
 * content.js - 注入页面的内容脚本
 * 负责在页面上下文中执行来自 background 的操作指令
 */

(function () {
  'use strict';

  // 防止重复注入
  if (window.__vivianContentLoaded) return;
  window.__vivianContentLoaded = true;

  // 监听来自 background 的消息
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    handleMessage(msg)
      .then(result => sendResponse({ ok: true, result }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // 保持异步
  });

  async function handleMessage(msg) {
    const timeout = (ms) => new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), ms)
    );

    switch (msg.type) {
      case 'get_content':
        return getContent();

      case 'click':
        return await Promise.race([click(msg.selector), timeout(10000)]);

      case 'fill':
        return await Promise.race([fill(msg.selector, msg.value), timeout(10000)]);

      case 'scroll':
        return scroll(msg.x, msg.y);

      case 'eval':
        return await Promise.race([evalCode(msg.code), timeout(10000)]);

      default:
        throw new Error(`Unknown message type: ${msg.type}`);
    }
  }

  // 获取页面内容
  function getContent() {
    const text = document.body?.innerText || '';
    const clone = document.body?.cloneNode(true);
    if (clone) {
      clone.querySelectorAll('script, style, noscript, svg').forEach(el => el.remove());
      const html = clone.innerHTML
        .replace(/\s{2,}/g, ' ')
        .replace(/<!--[\s\S]*?-->/g, '')
        .trim();
      return {
        text: text.slice(0, 50000),
        html: html.slice(0, 100000),
        url: location.href,
        title: document.title
      };
    }
    return { text: text.slice(0, 50000), html: '', url: location.href, title: document.title };
  }

  // 点击元素
  async function click(selector) {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);
    el.click();
    return `Clicked: ${selector}`;
  }

  // 填写表单
  async function fill(selector, value) {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);
    el.focus();
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return `Filled: ${selector} = ${value}`;
  }

  // 滚动页面
  function scroll(x, y) {
    window.scrollTo(x ?? 0, y ?? 0);
    return `Scrolled to (${x}, ${y})`;
  }

  // 执行代码
  async function evalCode(code) {
    try {
      // eslint-disable-next-line no-eval
      const result = eval(code);
      if (result instanceof Promise) {
        return await result;
      }
      return result;
    } catch (e) {
      throw new Error(`Eval error: ${e.message}`);
    }
  }
})();
