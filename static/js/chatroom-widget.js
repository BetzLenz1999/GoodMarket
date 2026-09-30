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

  // ── Tipping ───────────────────────────────────────────────────────────
  // A tip is a REAL on-chain transfer signed by the sender's own wallet. The
  // widget resolves the recipient, hands the unsigned tx to the wallet, then
  // posts the hash back for the backend to verify before it is announced.
  var TIP_BOOT = {
    wallet: '',
    loginMethod: '',
    tokens: [],
    wcProjectId: '',
    assetVersion: '',
    celoChainId: 42220,
    xdcChainId: 50,
    celoRpc: 'https://forno.celo.org',
    xdcRpc: 'https://earpc.xinfin.network'
  };
  var CHAIN_META = {
    celo: { hex: '0xa4ec', id: 42220, name: 'Celo Mainnet', symbol: 'CELO',
            rpc: 'https://forno.celo.org', explorer: 'https://celoscan.io/tx/' },
    xdc: { hex: '0x32', id: 50, name: 'XDC Network', symbol: 'XDC',
           rpc: 'https://earpc.xinfin.network', explorer: 'https://xdcscan.io/tx/' }
  };
  var tipBusy = false;

  function configureTip(opts) {
    opts = opts || {};
    for (var k in opts) {
      if (Object.prototype.hasOwnProperty.call(opts, k)) TIP_BOOT[k] = opts[k];
    }
    if (!TIP_BOOT.wallet && window.GM_CHAT_BOOT && window.GM_CHAT_BOOT.wallet) {
      TIP_BOOT.wallet = window.GM_CHAT_BOOT.wallet;
    }
    if (!TIP_BOOT.loginMethod && window.GM_WALLET_BOOT && window.GM_WALLET_BOOT.wallet) {
      TIP_BOOT.loginMethod = window.GM_WALLET_BOOT.loginMethod;
    }
    if (!TIP_BOOT.wallet && window.WALLET_ADDRESS) TIP_BOOT.wallet = window.WALLET_ADDRESS;
  }

  function _isLocalLogin() {
    return (TIP_BOOT.loginMethod || '').toLowerCase() === 'local';
  }

  function _prefersWc() {
    try {
      return typeof GMWalletConnect !== 'undefined'
        && typeof GMWalletConnect.prefersWcSigning === 'function'
        && GMWalletConnect.prefersWcSigning();
    } catch (_) { return false; }
  }

  function _tokenMeta(key) {
    var list = TIP_BOOT.tokens || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].key === key) return list[i];
    }
    return null;
  }

  function _tipTokenLabel(key) {
    var meta = _tokenMeta(key);
    if (meta && meta.label) return meta.label;
    return { GD: 'G$', CELO: 'CELO', XDC_GD: 'XDC G$', XDC: 'XDC' }[key] || key;
  }

  function _tipTokenNetwork(key) {
    var meta = _tokenMeta(key);
    return (meta && meta.network) || 'celo';
  }

  function _explorerUrl(key, hash) {
    var net = _tipTokenNetwork(key);
    var base = (CHAIN_META[net] && CHAIN_META[net].explorer) || 'https://celoscan.io/tx/';
    return hash ? base + hash : '';
  }

  function _shortHash(hash) {
    if (!hash || hash.length < 14) return hash || '';
    return hash.slice(0, 10) + '…' + hash.slice(-6);
  }

  // GMLocalWallet decrypts + signs with ethers; the standalone chatroom page
  // has no other reason to load it, so pull it in on demand. (No-op elsewhere.)
  var ETHER_CANDIDATES = [
    { src: 'https://cdnjs.cloudflare.com/ajax/libs/ethers/6.13.4/ethers.umd.min.js',
      integrity: 'sha384-6Zl0Pc8zjSz8KvmNeXRvUQgY4ryFb+BwDvKCmLYcBME0joAaru491tQgi9B7zsMM' },
    { src: 'https://cdn.jsdelivr.net/npm/ethers@6.13.4/dist/ethers.umd.min.js' }
  ];

  function _ensureEthers() {
    if (typeof ethers !== 'undefined') return Promise.resolve(true);
    return new Promise(function (resolve) {
      var index = 0;
      function attempt() {
        if (typeof ethers !== 'undefined') { resolve(true); return; }
        if (index >= ETHER_CANDIDATES.length) { resolve(false); return; }
        var cand = ETHER_CANDIDATES[index++];
        var s = document.createElement('script');
        s.src = cand.src;
        if (cand.integrity) { s.integrity = cand.integrity; s.crossOrigin = 'anonymous'; }
        s.referrerPolicy = 'no-referrer';
        s.onload = function () { resolve(typeof ethers !== 'undefined'); };
        s.onerror = attempt;
        document.head.appendChild(s);
      }
      attempt();
    });
  }

  // Resolve an EIP-1193 provider for THIS login method. Local logins must never
  // fall through to an injected extension (a different account entirely).
  async function _tipProvider() {
    if (_isLocalLogin()) {
      if (typeof GMLocalWallet === 'undefined') {
        throw new Error('Your in-app wallet is still loading. Please try again.');
      }
      if (typeof ethers === 'undefined') {
        var loaded = await _ensureEthers();
        if (!loaded) throw new Error('Could not load the wallet library. Please check your connection and try again.');
      }
      if (!GMLocalWallet.isUnlocked() && typeof window._lwOpenUnlockModal === 'function') {
        await window._lwOpenUnlockModal({
          title: 'Sign this tip',
          subtitle: 'Enter your PIN to send your tip',
          submitLabel: 'Sign & Send',
          busyLabel: 'Signing…'
        });
      }
      if (!GMLocalWallet.isUnlocked()) {
        throw new Error('Your wallet is still locked. Please enter your PIN to send the tip.');
      }
      return GMLocalWallet.getProvider();
    }
    if (_prefersWc() && typeof GMWalletConnect !== 'undefined') {
      return await GMWalletConnect.getProvider();
    }
    // Privy wallets are exposed by wallet-main.js as GMPrivyWallets.
    var privy = Array.isArray(window.GMPrivyWallets) ? window.GMPrivyWallets : [];
    for (var i = 0; i < privy.length; i++) {
      if (privy[i] && privy[i].provider && typeof privy[i].provider.request === 'function') {
        return privy[i].provider;
      }
    }
    if (typeof window.ethereum !== 'undefined') return window.ethereum;
    if (typeof GMWalletConnect !== 'undefined' && GMWalletConnect.isPreferred()) {
      return await GMWalletConnect.getProvider();
    }
    throw new Error('No wallet detected. Please open GoodMarket in MetaMask, Trust Wallet or another Celo wallet.');
  }

  async function _tipEnsureChain(provider, netKey) {
    var chain = CHAIN_META[netKey] || CHAIN_META.celo;
    var current = null;
    try { current = await provider.request({ method: 'eth_chainId' }); } catch (_) {}
    if (String(current || '').toLowerCase() === chain.hex) return;
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chain.hex }] });
    } catch (err) {
      var msg = (err && err.message) || '';
      if (err && (err.code === 4902 || /Unrecognized chain|not added/i.test(msg))) {
        await provider.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: chain.hex,
            chainName: chain.name,
            nativeCurrency: { name: chain.symbol, symbol: chain.symbol, decimals: 18 },
            rpcUrls: [chain.rpc],
            blockExplorerUrls: [chain.explorer.replace('/tx/', '')]
          }]
        });
      } else {
        throw err;
      }
    }
  }

  async function _tipSendTransaction(provider, prep) {
    if (_isLocalLogin()) {
      // The in-app wallet signs locally and pays its own gas — no chain
      // switch prompt is needed (it routes by the tx's chainId).
      return await provider.request({
        method: 'eth_sendTransaction',
        params: [{ from: TIP_BOOT.wallet, to: prep.to, data: prep.data || '0x', value: prep.value || '0x0', chainId: prep.chain_id }]
      });
    }
    await _tipEnsureChain(provider, prep.network);
    var accounts = [];
    try { accounts = await provider.request({ method: 'eth_requestAccounts' }) || []; } catch (_) {}
    if (!accounts.length) {
      try { accounts = await provider.request({ method: 'eth_accounts' }) || []; } catch (_) {}
    }
    var wanted = (TIP_BOOT.wallet || '').toLowerCase();
    var from = null;
    for (var i = 0; i < accounts.length; i++) {
      if (String(accounts[i]).toLowerCase() === wanted) { from = accounts[i]; break; }
    }
    if (!from) {
      throw new Error('Wrong wallet connected. Please switch to your GoodMarket wallet before tipping.');
    }
    return await provider.request({
      method: 'eth_sendTransaction',
      params: [{ from: from, to: prep.to, data: prep.data || '0x', value: prep.value || '0x0' }]
    });
  }

  async function sendTip(username, token, amount, onStatus) {
    var say = typeof onStatus === 'function' ? onStatus : function () {};
    if (tipBusy) return null;
    tipBusy = true;
    try {
      say('Preparing tip…');
      var prepRes = await fetch('/chatroom/api/tip/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, token: token, amount: amount })
      });
      var prep = await prepRes.json();
      if (!prep || !prep.success) {
        throw new Error((prep && prep.error) || 'Could not prepare the tip.');
      }

      say('Confirm in your wallet…');
      var provider = await _tipProvider();
      var txHash = await _tipSendTransaction(provider, prep);
      if (!txHash) throw new Error('Your wallet did not return a transaction hash.');

      say('Verifying on-chain…');
      var confRes = await fetch('/chatroom/api/tip/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, token: token, amount: amount, tx_hash: txHash })
      });
      var confirmed = await confRes.json();
      if (!confirmed || !confirmed.success) {
        // The transfer is already broadcast at this point, so the hash must
        // reach the user — a retry with the same hash is idempotent server-side
        // and support can trace it. Never imply the money did not move.
        var err = new Error(((confirmed && confirmed.error) || 'The tip could not be verified yet.')
          + ' Transaction: ' + txHash + ' (do not send again — this one may still confirm).');
        err.txHash = txHash;
        throw err;
      }
      return confirmed;
    } finally {
      tipBusy = false;
    }
  }

  function _tipModal() {
    return document.querySelector('[data-gm-tip-modal]');
  }

  function _tipSetStatus(text, isError) {
    var node = document.querySelector('[data-gm-tip-status]');
    if (!node) return;
    node.textContent = text || '';
    node.classList.toggle('is-error', !!isError);
  }

  function closeTipModal() {
    var modal = _tipModal();
    if (modal) modal.hidden = true;
  }

  function openTipModal(username) {
    var modal = _tipModal();
    if (!modal) return;
    var name = (username || '').replace(/^@/, '');
    var title = modal.querySelector('[data-gm-tip-title]');
    if (title) title.textContent = 'Tip @' + name;
    modal.setAttribute('data-gm-tip-user', name);
    var amount = modal.querySelector('[data-gm-tip-amount]');
    if (amount) amount.value = '';
    _tipSetStatus('');
    modal.hidden = false;
    var first = modal.querySelector('[data-gm-tip-amount]');
    if (first) setTimeout(function () { try { first.focus(); } catch (_) {} }, 0);
  }

  async function _submitTipFromModal(modal, list, status, renderMessage) {
    var username = modal.getAttribute('data-gm-tip-user') || '';
    var amountEl = modal.querySelector('[data-gm-tip-amount]');
    var select = modal.querySelector('[data-gm-tip-token]');
    var amount = amountEl ? amountEl.value.trim() : '';
    var token = select ? select.value : 'GD';
    if (!amount || parseFloat(amount) <= 0) {
      _tipSetStatus('Enter a valid amount.', true);
      return;
    }
    try {
      var result = await sendTip(username, token, amount, function (msg) { _tipSetStatus(msg); });
      _tipSetStatus('');
      closeTipModal();
      if (result && result.message && typeof renderMessage === 'function') {
        renderMessage(result.message);
        if (list) list.scrollTop = list.scrollHeight;
      }
      var tip = (result && result.tip) || {};
      if (status) {
        status.textContent = '✅ Tip sent! ' + (tip.amount || amount) + ' ' + (tip.token_label || _tipTokenLabel(token))
          + ' to @' + username + (tip.tx_hash ? ' — tx ' + _shortHash(tip.tx_hash) : '');
      }
    } catch (err) {
      _tipSetStatus((err && err.message) || 'Tip failed.', true);
    }
  }

  // Every value is written with textContent (never innerHTML) — the message
  // body is untrusted user input.
  function buildChatRow(msg) {
    var row = el('div', 'gm-chat-row' + (msg.is_me ? ' is-me' : ''));
    var meta = el('div', 'gm-chat-meta');
    var name = el('span', 'gm-chat-name', '@' + (msg.username || 'anonymous'));
    // Tapping someone's @username opens the tip sheet — the primary, most
    // discoverable way to tip (the 💸 button below is the second one).
    if (!msg.is_me && msg.username) {
      name.classList.add('is-tippable');
      name.setAttribute('role', 'button');
      name.setAttribute('tabindex', '0');
      name.setAttribute('title', 'Tip @' + msg.username);
      name.addEventListener('click', function () { openTipModal(msg.username); });
      name.addEventListener('keydown', function (ev) {
        if (ev && (ev.key === 'Enter' || ev.key === ' ')) openTipModal(msg.username);
      });
    }
    meta.appendChild(name);
    meta.appendChild(el('span', 'gm-chat-time', formatChatTime(msg.created_at)));
    row.appendChild(meta);

    var isTip = msg.message_type === 'tip' && msg.tip;
    if (isTip) {
      row.classList.add('is-tip');
      var card = el('div', 'gm-chat-tip-card');
      card.appendChild(el('div', 'gm-chat-tip-head',
        '🎁 ' + (msg.tip.amount || '') + ' ' + _tipTokenLabel(msg.tip.token)));
      card.appendChild(el('div', 'gm-chat-tip-body', msg.message));
      var url = _explorerUrl(msg.tip.token, msg.tip.tx_hash);
      if (url) {
        var link = el('a', 'gm-chat-tip-link', 'View tx ↗');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        card.appendChild(link);
      }
      row.appendChild(card);
    } else {
      row.appendChild(el('div', 'gm-chat-bubble', msg.message));
    }

    if (!msg.is_me && msg.id) {
      var actions = el('div', 'gm-chat-actions');
      if (msg.username) {
        var tipBtn = el('button', 'gm-chat-tip', '💸 Tip');
        tipBtn.type = 'button';
        tipBtn.addEventListener('click', function () { openTipModal(msg.username); });
        actions.appendChild(tipBtn);
      }
      var report = el('button', 'gm-chat-report', 'Report');
      report.type = 'button';
      report.addEventListener('click', function () { reportChatMessage(msg.id, report); });
      actions.appendChild(report);
      row.appendChild(actions);
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

    // Dedupe by id: a tip is rendered the instant it is confirmed AND will also
    // arrive on the next after_id poll, so without this it would show twice.
    var renderedIds = {};

    function appendMessage(m) {
      if (!m || m.id == null) return false;
      if (renderedIds[m.id]) return false;
      renderedIds[m.id] = true;
      var empty = list.querySelector('.gm-chat-empty');
      if (empty) empty.remove();
      list.appendChild(buildChatRow(m));
      if (m.id > lastId) lastId = m.id;
      return true;
    }

    function appendMessages(messages) {
      if (!messages || !messages.length) return;
      messages.forEach(appendMessage);
      list.scrollTop = list.scrollHeight;
    }

    async function loadState() {
      try {
        var res = await fetch('/chatroom/api/state');
        if (!res.ok) return;
        var data = await res.json();
        retryUntil = data.retry_after ? Date.now() + data.retry_after * 1000 : 0;
        // The server is the source of truth for the tip tokens on offer.
        if (data.tip_tokens && data.tip_tokens.length) TIP_BOOT.tokens = data.tip_tokens;
        if (data.wallet) TIP_BOOT.wallet = data.wallet;
        if (data.has_username === false) {
          setStatus('Tip: set a username on the wallet page so people can tip you.');
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

    // Tip modal — lives in the page (not the widget root) so it can overlay
    // everything. Handled globally by this mount.
    var tipModal = _tipModal();
    if (tipModal) {
      var tipForm = tipModal.querySelector('[data-gm-tip-form]');
      if (tipForm) {
        tipForm.addEventListener('submit', function (event) {
          event.preventDefault();
          _submitTipFromModal(tipModal, list, status, appendMessage);
        });
      }
      var tipClose = tipModal.querySelector('[data-gm-tip-close]');
      if (tipClose) tipClose.addEventListener('click', closeTipModal);
      tipModal.addEventListener('click', function (event) {
        if (event.target === tipModal) closeTipModal();
      });
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

  window.GMChatroom = {
    mount: mount,
    buildChatRow: buildChatRow,
    configure: configureTip,
    sendTip: sendTip,
    openTipModal: openTipModal,
    closeTipModal: closeTipModal,
    tipTokens: function () { return (TIP_BOOT.tokens || []).slice(); }
  };

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
    // Pick up the per-request boot values (wallet / login method) so tipping
    // knows which signer to use even before /api/state answers.
    configureTip();
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
