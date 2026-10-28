// js/views/toast.js - the transient toast. Every view may call it; it
// depends on nothing but the DOM.

import { $ } from '../util.js';

let toastTimer = null;
export function toast(text) {
  let el = $('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.style.cssText = 'position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:30;' +
      'background:var(--panel2);border:1px solid var(--line);border-radius:999px;padding:8px 18px;' +
      'font-size:13px;color:var(--fg);max-width:86vw;box-shadow:0 6px 20px rgba(0,0,0,.5)';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = 'none'; }, 2600);
}
