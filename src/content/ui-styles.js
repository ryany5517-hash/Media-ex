/**
 * Stream Radar — UI stylesheet.
 * The string is injected into a *closed shadow root*, so none of these rules can
 * leak into the host page (no `!important` wars, no id collisions).
 * `srad-` prefixes are kept anyway so DevTools stay readable.
 */
(function (root) {
  'use strict';
  const SR = (root.SR = root.SR || {});

  SR.uiCss = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }

/* ---------- tokens ---------- */
.srad-root {
  --bg: rgba(255,255,255,.72);
  --bg-solid: #ffffff;
  --bg-2: rgba(15,18,28,.04);
  --fg: #10131c;
  --fg-2: rgba(16,19,28,.62);
  --line: rgba(16,19,28,.12);
  --accent: #6d5efc;
  --accent-2: #00d1b2;
  --ok: #16a34a;
  --warn: #d97706;
  --err: #dc2626;
  --shadow: 0 18px 48px rgba(8,10,20,.22), 0 2px 8px rgba(8,10,20,.12);
  --radius: 18px;
  --blur: saturate(1.5) blur(18px);
  position: fixed !important;
  inset: 0 !important;
  z-index: 2147483000 !important;
  display: block;
  pointer-events: none;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color: var(--fg);
  font-size: 14px;
  line-height: 1.45;
}
.srad-root[data-theme="dark"] {
  --bg: rgba(19,22,33,.78);
  --bg-solid: #141726;
  --bg-2: rgba(255,255,255,.06);
  --fg: #e9edf7;
  --fg-2: rgba(233,237,247,.62);
  --line: rgba(233,237,247,.14);
  --accent: #8b7cff;
  --accent-2: #2ee6c5;
  --shadow: 0 18px 48px rgba(0,0,0,.55), 0 2px 8px rgba(0,0,0,.35);
}

/* ---------- floating action button ---------- */
.srad-fab {
  pointer-events: auto;
  position: absolute;
  right: 20px;
  bottom: 20px;
  width: 58px;
  height: 58px;
  border-radius: 50%;
  border: 1px solid rgba(255,255,255,.28);
  background: linear-gradient(150deg, var(--accent) 0%, #4b3ff0 55%, var(--accent-2) 140%);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: var(--shadow);
  backdrop-filter: var(--blur);
  -webkit-backdrop-filter: var(--blur);
  transition: transform .18s cubic-bezier(.2,.9,.3,1.3), box-shadow .18s ease, opacity .2s ease;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  opacity: .96;
}
.srad-fab:hover { transform: translateY(-2px) scale(1.04); }
.srad-fab:active { transform: scale(.96); }
.srad-fab:focus-visible { outline: 3px solid var(--accent-2); outline-offset: 3px; }
.srad-fab[data-dragging="1"] { transition: none; transform: scale(1.08); cursor: grabbing; opacity: 1; }
.srad-fab svg { width: 26px; height: 26px; display: block; }
.srad-fab::after {
  content: "";
  position: absolute;
  inset: -6px;
  border-radius: 50%;
  border: 2px solid var(--accent-2);
  opacity: 0;
  pointer-events: none;
}
.srad-fab[data-pulse="1"]::after { animation: srad-pulse 1.25s ease-out 2; }
@keyframes srad-pulse {
  0%   { opacity: .85; transform: scale(.85); }
  100% { opacity: 0;   transform: scale(1.5); }
}
.srad-badge {
  position: absolute;
  top: -4px;
  right: -6px;
  min-width: 22px;
  height: 22px;
  padding: 0 6px;
  border-radius: 11px;
  background: #ff3d5e;
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  line-height: 22px;
  text-align: center;
  box-shadow: 0 2px 10px rgba(255,61,94,.55);
  transform: scale(0);
  transition: transform .22s cubic-bezier(.2,.9,.3,1.4);
}
.srad-badge[data-show="1"] { transform: scale(1); }
.srad-fab[data-live="1"] { box-shadow: var(--shadow), 0 0 0 2px rgba(46,230,197,.6); }

/* ---------- panel ---------- */
.srad-panel {
  pointer-events: auto;
  position: absolute;
  width: min(430px, calc(100vw - 24px));
  max-height: min(78vh, 720px);
  right: 20px;
  bottom: 92px;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  backdrop-filter: var(--blur);
  -webkit-backdrop-filter: var(--blur);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  color: var(--fg);
  overflow: hidden;
  transform-origin: bottom right;
  opacity: 0;
  transform: translateY(10px) scale(.97);
  transition: opacity .16s ease, transform .2s cubic-bezier(.2,.9,.3,1.2);
  visibility: hidden;
}
.srad-panel[data-open="1"] { opacity: 1; transform: none; visibility: visible; }
.srad-panel[data-anchor="tl"] { right: auto; left: 20px; top: 92px; bottom: auto; transform-origin: top left; }
.srad-panel[data-anchor="tr"] { right: 20px; top: 92px; bottom: auto; transform-origin: top right; }
.srad-panel[data-anchor="bl"] { right: auto; left: 20px; bottom: 92px; transform-origin: bottom left; }

.srad-head { display: flex; gap: 8px; align-items: center; padding: 12px 12px 10px; border-bottom: 1px solid var(--line); cursor: grab; }
.srad-head[data-drag="1"] { cursor: grabbing; }
.srad-title { font-weight: 700; font-size: 14px; letter-spacing: .2px; display: flex; align-items: center; gap: 8px; min-width: 0; }
.srad-title .srad-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 4px rgba(22,163,74,.16); flex: none; }
.srad-title .srad-dot[data-off="1"] { background: var(--warn); box-shadow: 0 0 0 4px rgba(217,119,6,.16); }
.srad-title small { font-weight: 500; color: var(--fg-2); font-size: 11.5px; display: block; max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.srad-spacer { flex: 1 1 auto; }

.srad-iconbtn {
  pointer-events: auto;
  width: 44px; height: 44px; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 12px; border: 1px solid transparent; background: transparent;
  color: var(--fg); cursor: pointer; transition: background .15s ease, transform .15s ease;
  padding: 0;
}
.srad-iconbtn + .srad-iconbtn { margin-left: -4px; }
.srad-iconbtn:hover { background: var(--bg-2); }
.srad-iconbtn:active { transform: scale(.94); }
.srad-iconbtn:focus-visible { outline: 2px solid var(--accent-2); outline-offset: -2px; }
.srad-iconbtn svg { width: 20px; height: 20px; }

.srad-meta { padding: 10px 14px 0; display: flex; flex-wrap: wrap; gap: 6px; }
.srad-chip {
  font-size: 11.5px; font-weight: 600; padding: 3px 9px; border-radius: 999px;
  background: var(--bg-2); border: 1px solid var(--line); color: var(--fg-2);
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.srad-chip[data-kind="year"] { color: var(--fg); }
.srad-chip[data-kind="ep"] { background: rgba(109,94,252,.14); border-color: rgba(109,94,252,.35); color: var(--accent); }
.srad-chip[data-kind="junk"] { background: rgba(217,119,6,.14); border-color: rgba(217,119,6,.4); color: var(--warn); }

.srad-list { overflow: auto; padding: 8px 10px 4px; scroll-behavior: smooth; flex: 1 1 auto; overscroll-behavior: contain; }
.srad-list::-webkit-scrollbar { width: 10px; }
.srad-list::-webkit-scrollbar-thumb { background: var(--line); border-radius: 8px; border: 3px solid transparent; background-clip: content-box; }

.srad-empty { padding: 26px 22px 30px; text-align: center; color: var(--fg-2); }
.srad-empty strong { display: block; color: var(--fg); font-size: 15px; margin-bottom: 6px; }
.srad-empty .srad-spin { width: 26px; height: 26px; margin: 0 auto 12px; border-radius: 50%; border: 2.5px solid var(--line); border-top-color: var(--accent); animation: srad-spin 1s linear infinite; }
@keyframes srad-spin { to { transform: rotate(360deg); } }

.srad-item {
  position: relative; display: grid; grid-template-columns: 54px 1fr; gap: 10px;
  padding: 10px; border-radius: 14px; border: 1px solid var(--line); background: var(--bg-solid);
  margin-bottom: 8px; animation: srad-in .26s cubic-bezier(.2,.9,.3,1.2);
}
@keyframes srad-in { from { opacity: 0; transform: translateY(8px); } }
.srad-item:focus-within, .srad-item[data-active="1"] { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(109,94,252,.18); }
.srad-item[data-ad="1"] { opacity: .72; }
.srad-thumb {
  width: 54px; height: 54px; border-radius: 11px; overflow: hidden; background: var(--bg-2);
  display: flex; align-items: center; justify-content: center; font-size: 10.5px; font-weight: 800;
  letter-spacing: .4px; color: #fff; position: relative; flex: none;
}
.srad-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.srad-thumb[data-cat="hls"] { background: linear-gradient(140deg,#f97316,#c2410c); }
.srad-thumb[data-cat="dash"] { background: linear-gradient(140deg,#0ea5e9,#1d4ed8); }
.srad-thumb[data-cat="mp4"] { background: linear-gradient(140deg,#22c55e,#0f766e); }
.srad-thumb[data-cat="webm"] { background: linear-gradient(140deg,#a855f7,#6d28d9); }
.srad-thumb[data-cat="blob"] { background: linear-gradient(140deg,#64748b,#334155); }
.srad-thumb[data-cat="segment"] { background: linear-gradient(140deg,#eab308,#a16207); }
.srad-thumb[data-cat="texttrack"] { background: linear-gradient(140deg,#14b8a6,#0f766e); }

.srad-main { min-width: 0; }
.srad-row1 { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.srad-name { font-weight: 650; font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; }
.srad-url { color: var(--fg-2); font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; }
.srad-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
.srad-tag { font-size: 10.5px; font-weight: 700; padding: 2px 7px; border-radius: 7px; background: var(--bg-2); border: 1px solid var(--line); color: var(--fg-2); }
.srad-tag[data-tone="q"] { background: rgba(109,94,252,.12); border-color: rgba(109,94,252,.3); color: var(--accent); }
.srad-tag[data-tone="ok"] { background: rgba(22,163,74,.13); border-color: rgba(22,163,74,.32); color: var(--ok); }
.srad-tag[data-tone="warn"] { background: rgba(217,119,6,.14); border-color: rgba(217,119,6,.34); color: var(--warn); }
.srad-tag[data-tone="err"] { background: rgba(220,38,38,.12); border-color: rgba(220,38,38,.3); color: var(--err); }
.srad-conf { display: inline-flex; gap: 3px; align-items: center; margin-left: auto; flex: none; }
.srad-conf i { width: 6px; height: 6px; border-radius: 50%; background: var(--line); display: block; }
.srad-conf i[data-on="1"] { background: var(--accent-2); }

.srad-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }
.srad-btn {
  pointer-events: auto; display: inline-flex; align-items: center; gap: 6px;
  min-height: 36px; padding: 0 11px; border-radius: 10px; cursor: pointer;
  border: 1px solid var(--line); background: var(--bg-2); color: var(--fg);
  font-size: 12px; font-weight: 600; font-family: inherit; transition: transform .12s ease, background .15s ease, border-color .15s ease;
}
.srad-btn:hover { background: var(--bg-solid); border-color: var(--accent); }
.srad-btn:active { transform: scale(.96); }
.srad-btn:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 2px; }
.srad-btn[data-primary="1"] { background: linear-gradient(150deg,var(--accent),#4b3ff0); border-color: transparent; color: #fff; }
.srad-btn svg { width: 15px; height: 15px; flex: none; }
.srad-btn[disabled] { opacity: .5; cursor: progress; }
.srad-btn[data-done="1"] { border-color: var(--ok); color: var(--ok); }

.srad-variants { margin-top: 8px; border-top: 1px dashed var(--line); padding-top: 6px; display: none; }
.srad-item[data-expanded="1"] .srad-variants { display: block; animation: srad-in .2s ease; }
.srad-variant { display: flex; align-items: center; gap: 8px; padding: 4px 2px; font-size: 12px; color: var(--fg-2); }
.srad-variant b { color: var(--fg); font-weight: 650; }
.srad-variant .srad-vq { min-width: 52px; font-weight: 700; color: var(--fg); }
.srad-variant button { margin-left: auto; }

.srad-foot { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--line); background: var(--bg-2); flex-wrap: wrap; }
.srad-switch { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; color: var(--fg-2); cursor: pointer; min-height: 36px; padding: 0 6px; border-radius: 9px; }
.srad-switch:hover { background: var(--bg-solid); }
.srad-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.srad-slider { width: 34px; height: 20px; border-radius: 999px; background: var(--line); position: relative; transition: background .18s ease; flex: none; }
.srad-slider::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.35); transition: transform .18s cubic-bezier(.2,.9,.3,1.3); }
.srad-switch input:checked + .srad-slider { background: var(--accent); }
.srad-switch input:checked + .srad-slider::after { transform: translateX(14px); }
.srad-switch input:focus-visible + .srad-slider { outline: 2px solid var(--accent-2); outline-offset: 2px; }

/* ---------- settings popover ---------- */
.srad-pop {
  position: absolute; inset: 0; background: var(--bg-solid); color: var(--fg);
  transform: translateY(100%); transition: transform .24s cubic-bezier(.2,.9,.3,1.1);
  display: flex; flex-direction: column; z-index: 3;
}
.srad-pop[data-open="1"] { transform: none; }
.srad-pop .srad-popbody { overflow: auto; padding: 12px 14px 20px; }
.srad-field { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--line); }
.srad-field label:first-child { flex: 1 1 auto; font-size: 13px; }
.srad-field .hint { color: var(--fg-2); font-size: 11.5px; display: block; }
.srad-seg { display: inline-flex; background: var(--bg-2); border: 1px solid var(--line); border-radius: 10px; padding: 2px; gap: 2px; }
.srad-seg button { border: 0; background: transparent; color: var(--fg-2); font: inherit; font-size: 12px; font-weight: 600; padding: 6px 10px; min-height: 32px; border-radius: 8px; cursor: pointer; }
.srad-seg button[data-on="1"] { background: var(--accent); color: #fff; }

/* ---------- toasts ---------- */
.srad-toasts {
  pointer-events: none; position: absolute; top: 14px; right: 14px;
  display: flex; flex-direction: column; gap: 8px; align-items: flex-end; width: min(360px, calc(100vw - 28px));
}
.srad-toast {
  pointer-events: auto; display: flex; align-items: center; gap: 9px; max-width: 100%;
  padding: 10px 13px; border-radius: 13px; background: var(--bg); border: 1px solid var(--line);
  box-shadow: var(--shadow); backdrop-filter: var(--blur); -webkit-backdrop-filter: var(--blur);
  color: var(--fg); font-size: 12.5px; font-weight: 550;
  animation: srad-toast-in .26s cubic-bezier(.2,.9,.3,1.2);
  position: relative; overflow: hidden;
}
.srad-toast[data-leaving="1"] { animation: srad-toast-out .22s ease forwards; }
@keyframes srad-toast-in { from { opacity: 0; transform: translateX(24px) scale(.96); } }
@keyframes srad-toast-out { to { opacity: 0; transform: translateX(24px) scale(.96); } }
.srad-toast .srad-tico { width: 20px; height: 20px; flex: none; display: flex; align-items: center; justify-content: center; border-radius: 7px; }
.srad-toast[data-kind="ok"] .srad-tico { background: rgba(22,163,74,.16); color: var(--ok); }
.srad-toast[data-kind="info"] .srad-tico { background: rgba(109,94,252,.16); color: var(--accent); }
.srad-toast[data-kind="warn"] .srad-tico { background: rgba(217,119,6,.18); color: var(--warn); }
.srad-toast[data-kind="err"] .srad-tico { background: rgba(220,38,38,.16); color: var(--err); }
.srad-toast .srad-tbar { position: absolute; left: 0; bottom: 0; height: 2px; background: var(--accent); animation: srad-shrink 4s linear forwards; }
@keyframes srad-shrink { from { width: 100%; } to { width: 0%; } }
.srad-toast button { border: 0; background: var(--bg-2); border-radius: 8px; color: var(--fg); font: inherit; font-size: 11.5px; font-weight: 700; padding: 4px 8px; cursor: pointer; min-height: 28px; }
.srad-toast svg { width: 16px; height: 16px; }

/* ---------- mobile / touch ---------- */
@media (max-width: 720px), (coarse-pointer: coarse) and (max-width: 900px) {
  .srad-fab { width: 52px; height: 52px; right: 12px; bottom: 12px; }
  .srad-panel {
    right: 0 !important; left: 0 !important; top: auto !important; bottom: 0 !important;
    width: 100vw; max-width: 100vw; max-height: 82vh; border-radius: 20px 20px 0 0;
    transform-origin: bottom center; transform: translateY(16px);
  }
  .srad-panel .srad-actions { padding-bottom: env(safe-area-inset-bottom, 0); }
  .srad-btn { min-height: 44px; flex: 1 1 auto; justify-content: center; }
  .srad-toasts { top: 8px; left: 8px; right: 8px; width: auto; align-items: stretch; }
  .srad-list { padding-bottom: 12px; }
}
.srad-sr { position: absolute !important; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

@media (prefers-reduced-motion: reduce) {
  .srad-root *, .srad-root *::before, .srad-root *::after { animation-duration: .001s !important; transition-duration: .001s !important; }
}
`;
})(typeof globalThis !== 'undefined' ? globalThis : window);
