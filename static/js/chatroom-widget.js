// Public Community Chatroom widget — SEPARATE from the GoodMarket Agent.
//
// Own floating launcher + panel. Opens automatically on page load and polls
// on a fast, adaptive interval so a new message shows up within ~1s.
//
// Why not SSE / WebSocket: the app runs gunicorn with `gthread` (4 workers ×
// 4 threads = 16 concurrent slots). A held-open SSE connection would pin one
// slot per visitor and stall the whole app at ~16 users. Short incremental
// polls release the slot immediately, and the `after_id` cursor makes each one
// a tiny indexed query.
(function () {
  'use strict';

  // Poll cadence. FAST is the "someone may be typing" cadence while the panel
  // is open; IDLE is used while collapsed (we only need the unread badge).
  var POLL_FAST_MS = 1000;
  var POLL_IDLE_MS = 5000;
  var POLL_MAX_MS = 15000;      // backoff ceiling after repeated failures
  var MAX_MESSAGE_LEN = 500;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function formatChatTime(iso) {
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (_) {
      return '';
    }
  }

  function reportChatMessage(id, btn) {
    btn.disabled = true;
    fetch('/chatroom/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_id: id })
    }).then(function (res) { return res.json(); }).then(function (data) {
      if (data && data.success) {
        btn.textContent = 'Reported';
      } else {
        btn.textContent = 'Report failed';
        btn.disabled = false;
      }
    }).catch(function () {
      btn.textContent = 'Report failed';
      btn.disabled = false;
    });
  }

  // Every value is written with textContent (never innerHTML) — the message
  // body is untrusted user input.
  function buildChatRow(msg) {
    var row = el('div', 'gm-chat-row' + (msg.is_me ? ' is-me' : ''));
    var meta = el('div', 'gm-chat-meta');
    meta.appendChild(el('span', 'gm-chat-name', '@' + (msg.username || 'anonymous')));
    meta.appendChild(el('span', 'gm-chat-time', formatChatTime(msg.created_at)));
    row.appendChild(meta);
    row.appendChild(el('div', 'gm-chat-bubble', msg.message));
    if (!msg.is_me && msg.id) {
      var report = el('button', 'gm-chat-report', 'Report');
      report.type = 'button';
      report.addEventListener('click', function () { reportChatMessage(msg.id, report); });
      row.appendChild(report);
    }
    return row;
  }

  function mount(root, opts) {
    opts = opts || {};
    root = root || document.querySelector('[data-gm-chatroom-root]');
    if (!root) return null;

    var panel = root.querySelector('[data-gm-chat-panel]') || root;
    var list = root.querySelector('[data-gm-chat-messages]');
    var status = root.querySelector('[data-gm-chat-status]');
    var form = root.querySelector('[data-gm-chat-form]');
    var input = root.querySelector('[data-gm-chat-input]');
    var toggle = root.querySelector('[data-gm-chat-toggle]');
    var badge = root.querySelector('[data-gm-chat-badge]');
    var closeBtn = root.querySelector('[data-gm-chat-close]');
    if (!list || !form) return null;

    var lastId = 0;
    var timer = null;
    var loading = false;
    var stopped = true;
    var open = false;
    var unread = 0;
    var retryUntil = 0;
    var interval = POLL_FAST_MS;
    // A brand-new mount must paint the existing backlog, so the first fetch is
    // always a "latest N" read; every later tick is a cheap after_id cursor.
    var needInitial = true;

    function setStatus(text) { if (status) status.textContent = text || ''; }

    function renderBadge() {
      if (!badge) return;
      badge.textContent = unread > 99 ? '99+' : String(unread);
      badge.hidden = unread === 0;
    }

    function setOpen(next) {
      open = !!next;
      panel.hidden = !open;
      if (toggle) toggle.hidden = open;
      if (open) {
        unread = 0;
        renderBadge();
        // Opening is the moment the user reads the room.
        if (input) setTimeout(function () { try { input.focus(); } catch (_) {} }, 0);
      }
      restart();
    }

    function appendMessages(messages) {
      if (!messages || !messages.length) return;
      var empty = list.querySelector('.gm-chat-empty');
      if (empty) empty.remove();
      messages.forEach(function (m) {
        list.appendChild(buildChatRow(m));
        if (m.id > lastId) lastId = m.id;
      });
      list.scrollTop = list.scrollHeight;
    }

    async function loadState() {
      try {
        var res = await fetch('/chatroom/api/state');
        if (!res.ok) return;
        var data = await res.json();
        retryUntil = data.retry_after ? Date.now() + data.retry_after * 1000 : 0;
        if (data.has_username === false) {
          setStatus('Tip: set a username on the wallet page so people know who you are.');
        }
      } catch (_) { /* next poll retries */ }
    }

    async function loadMessages() {
      if (loading) return true;
      loading = true;
      try {
        var url = needInitial
          ? '/chatroom/api/messages?limit=50'
          : '/chatroom/api/messages?after_id=' + encodeURIComponent(lastId);
        var res = await fetch(url);
        if (res.status === 403) {
          stop();
          setStatus('Chatroom is currently unavailable.');
          return false;
        }
        if (!res.ok) return false;
        var data = await res.json();
        if (data && data.success) {
          if (needInitial && (!data.messages || !data.messages.length)
              && !list.querySelector('.gm-chat-empty')) {
            list.appendChild(el('div', 'gm-chat-empty', 'No messages yet — say hi! 👋'));
          }
          if (needInitial) needInitial = false;
          var incoming = data.messages || [];
          appendMessages(incoming);
          // Only count as unread when the panel is collapsed — a message the
          // user is already looking at is not "new".
          if (!open) {
            var fromOthers = incoming.filter(function (m) { return !m.is_me; }).length;
            if (fromOthers) { unread += fromOthers; renderBadge(); }
          }
        }
        return true;
      } catch (_) {
        // network hiccup — the next tick retries
        return false;
      } finally {
        loading = false;
      }
    }

    function schedule() {
      if (stopped) return;
      if (timer) { clearTimeout(timer); timer = null; }
      timer = setTimeout(tick, interval);
    }

    async function tick() {
      timer = null;
      if (stopped) return;
      // A phone left in the background must not poll all night.
      if (document.hidden) { schedule(); return; }
      var ok = await loadMessages();
      // Adaptive cadence: fast while the user is watching, slower while the
      // panel is collapsed, and backing off on failures so a flaky network
      // cannot hammer the server.
      if (!ok) {
        interval = Math.min(interval * 2, POLL_MAX_MS);
      } else {
        interval = open ? POLL_FAST_MS : POLL_IDLE_MS;
      }
      schedule();
    }

    function start() {
      if (!stopped) return;
      stopped = false;
      interval = POLL_FAST_MS;
      loadState().then(function () { return loadMessages(); }).then(schedule);
    }

    function stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
    }

    function restart() {
      if (stopped) return;
      if (timer) { clearTimeout(timer); timer = null; }
      tick();
    }

    async function send(text) {
      var clean = (text || '').trim();
      if (!clean) return;
      if (retryUntil && Date.now() < retryUntil) {
        setStatus('Please wait a moment before posting again.');
        return;
      }
      input.value = '';
      setStatus('Sending…');
      try {
        var res = await fetch('/chatroom/api/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: clean })
        });
        var data = await res.json();
        if (data && data.success && data.message) {
          setStatus('');
          appendMessages([data.message]);
        } else if (res.status === 429) {
          retryUntil = Date.now() + (data.retry_after || 3) * 1000;
          setStatus('You are posting too fast — wait ' + (data.retry_after || 3) + 's.');
        } else if (res.status === 403) {
          setStatus('You cannot post in the chatroom.');
        } else {
          setStatus((data && data.error) || 'Failed to send message.');
        }
      } catch (_) {
        setStatus('Failed to send message.');
      }
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      send(input.value);
    });

    if (toggle) {
      toggle.addEventListener('click', function () { setOpen(true); });
    }
    if (closeBtn) {
      closeBtn.addEventListener('click', function () { setOpen(false); });
    }

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && !stopped) restart();
    });

    // Auto-open on load — the room is the point of the widget, so a collapsed
    // launcher would just hide it.
    setOpen(opts.autoOpen !== false);

    return {
      start: start,
      stop: stop,
      open: function () { setOpen(true); },
      close: function () { setOpen(false); },
      isOpen: function () { return open; }
    };
  }

  window.GMChatroom = { mount: mount, buildChatRow: buildChatRow };

  // The launcher must sit above the wallet bottom nav, whose height changes
  // when it re-wraps on this page.
  function positionChatroomLauncher() {
    var launcher = document.querySelector('.gm-chat-widget');
    if (!launcher) return;
    var nav = document.querySelector('.wallet-bottom-nav');
    var gap = 12;
    var bottom = nav ? nav.getBoundingClientRect().height + gap : 24;
    // If the GoodMarket Agent launcher is also on screen, stack above it so
    // the two floating buttons never overlap.
    var agent = document.querySelector('.gm-ai-agent');
    if (agent && !agent.querySelector('.gm-ai-panel:not([hidden])')) {
      var toggle = agent.querySelector('.gm-ai-toggle');
      if (toggle && toggle.style.display !== 'none') bottom += 56;
    }
    launcher.style.setProperty('--gm-chat-bottom', bottom + 'px');
  }

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-gm-chatroom-root]').forEach(function (root) {
      // The standalone /chatroom page mounts explicitly so it can control
      // auto-open; only in-page widgets self-mount here.
      if (root.hasAttribute('data-gm-chat-manual')) return;
      var controller = mount(root);
      if (controller) controller.start();
    });
    positionChatroomLauncher();
  });

  window.addEventListener('resize', positionChatroomLauncher);
  window.addEventListener('orientationchange', positionChatroomLauncher);
})();
