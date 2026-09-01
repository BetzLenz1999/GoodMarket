(function () {
  // Review cards rendered per pending action id, so a finished flow can
  // remove/replace its own card once the transaction succeeds.
  const _actionCards = new Map();
  let _activeActionId = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function addMessage(messages, type, text, action) {
    const msg = el('div', 'gm-ai-msg gm-ai-msg-' + type, text);
    if (action) msg.appendChild(renderActionCard(action));
    messages.appendChild(msg);
    messages.scrollTop = messages.scrollHeight;
    return msg;
  }

  async function continueWalletFlow(action, actionId) {
    if (!action) return false;
    _activeActionId = actionId || (action && action.id) || null;
    if (window.GoodMarketAI && typeof window.GoodMarketAI.handleConfirmedAction === 'function') {
      return window.GoodMarketAI.handleConfirmedAction(action);
    }
    if (action.action_type === 'send_gd' || action.action_type === 'stream_gd' || action.action_type === 'gcash_cashout') {
      const target = new URL('/wallet', window.location.origin);
      if (actionId) target.searchParams.set('ai_action', actionId);
      window.location.href = target.toString();
      return true;
    }
    if (action.action_type === 'mobile_load') {
      const target = new URL('/reloadly/', window.location.origin);
      if (actionId) target.searchParams.set('ai_action', actionId);
      target.hash = 'topup';
      window.location.href = target.toString();
      return true;
    }
    return false;
  }

  function signingLabel(loginMethod) {
    switch (String(loginMethod || '').toLowerCase()) {
      case 'local':
        return 'In-app GoodMarket wallet (PIN unlock)';
      case 'walletconnect':
      case 'manual':
      case 'manual_address':
        return 'WalletConnect session';
      case 'privy':
        return 'Privy embedded wallet';
      default:
        return 'Connected wallet (MetaMask / Trust / MiniPay)';
    }
  }

  // Display names for the token keys the backend emits — internal keys
  // (GDX/GD) must never leak into the review card.
  function _tokenLabel(key) {
    switch (String(key || '').trim().toUpperCase()) {
      case 'GDX': return 'G$ on XDC';
      case 'XDC': return 'XDC';
      case 'GD':  return 'G$';
      case 'CUSD': return 'cUSD';
      case 'USDT': return 'USDT';
      case 'CELO': return 'CELO';
      default: return key || '';
    }
  }

  function _routeLabel(payload) {
    if (payload.bridge_direction === 'celo_to_xdc') return 'G$: Celo → XDC';
    if (payload.bridge_direction === 'xdc_to_celo') return 'G$: XDC → Celo';
    if (payload.from_token && payload.to_token) {
      return _tokenLabel(payload.from_token) + ' → ' + _tokenLabel(payload.to_token);
    }
    return '';
  }

  // Success links used to be hardcoded to Celoscan — XDC-side flows
  // (bridge, XSwap) link to XDCScan, so derive the label from the URL.
  function _explorerLinkLabel(url) {
    const lower = String(url || '').toLowerCase();
    if (lower.indexOf('xdcscan') !== -1) return 'View on XDCScan ↗';
    if (lower.indexOf('celoscan') !== -1) return 'View on Celoscan ↗';
    if (lower.indexOf('layerzeroscan') !== -1) return 'Track on LayerZeroScan ↗';
    return 'View on explorer ↗';
  }

  function _formatNativeAmount(wei) {
    // Avoid converting a wei value to Number: a LayerZero fee is an integer
    // and Number can silently round it before the user reviews the preview.
    try {
      const value = BigInt(wei);
      const whole = value / 1000000000000000000n;
      const fraction = (value % 1000000000000000000n).toString().padStart(18, '0').slice(0, 6).replace(/0+$/, '');
      return whole.toString() + (fraction ? '.' + fraction : '');
    } catch (_) {
      return '';
    }
  }

  function _addReviewRow(dl, label, value) {
    if (!value) return;
    dl.appendChild(el('dt', '', label));
    dl.appendChild(el('dd', '', String(value)));
  }

  async function _hydrateBridgePreview(action, dl, button) {
    const payload = action.payload || {};
    const direction = payload.bridge_direction;
    if (action.action_type !== 'bridge' || !direction || !payload.amount) return;

    const sourceChainId = direction === 'xdc_to_celo' ? 50 : 42220;
    const targetChainId = direction === 'xdc_to_celo' ? 42220 : 50;
    const nativeSymbol = direction === 'xdc_to_celo' ? 'XDC' : 'CELO';
    _addReviewRow(dl, 'Estimated network fee', 'Calculating…');
    const feeValue = dl.lastElementChild;
    // The bridge transfers the requested G$ amount 1:1. Its LayerZero fee is
    // paid separately in the native token, so the amount shown here is not
    // reduced by the fee.
    _addReviewRow(dl, 'You receive', payload.amount + ' G$ on ' + (direction === 'xdc_to_celo' ? 'Celo' : 'XDC'));
    try {
      const query = new URLSearchParams({
        sourceChainId: String(sourceChainId),
        targetChainId: String(targetChainId),
        amount: String(payload.amount)
      });
      const response = await fetch('/api/xdc/bridge/estimate-fee?' + query.toString());
      const data = await response.json();
      const feeWei = data && (data.recommended_bridge_fee_wei || data.bridge_fee_wei);
      if (!response.ok || !data || !data.success || !feeWei || BigInt(feeWei) <= 0n) {
        throw new Error((data && data.error) || 'Bridge fee estimate unavailable');
      }
      const recommended = _formatNativeAmount(feeWei);
      feeValue.textContent = recommended + ' ' + nativeSymbol;
      // The XDC → Celo execution deliberately sends a 30% fee headroom to
      // match the manual bridge preflight. Make that maximum explicit instead
      // of making the chat look arbitrarily more expensive than /swap.
      if (direction === 'xdc_to_celo') {
        const maximum = _formatNativeAmount((BigInt(feeWei) * 130n) / 100n);
        _addReviewRow(dl, 'Fee sent (maximum)', maximum + ' XDC (30% safety buffer; unused value may be refunded)');
      }
    } catch (_) {
      feeValue.textContent = 'Unavailable — confirm only after checking your wallet fee';
    } finally {
      button.disabled = false;
      button.textContent = 'Confirm action';
    }
  }

  function renderActionCard(action) {
    const card = el('div', 'gm-ai-card');
    const title = el('strong', '', 'Review before signing');
    const dl = document.createElement('dl');
    const payload = action.payload || {};
    const rows = [
      ['Action', action.action_type],
      ['Amount', payload.flow_rate_per_day ? (payload.flow_rate_per_day + ' G$/day') : (payload.amount || payload.fiat_amount)],
      ['Token', payload.token ? _tokenLabel(payload.token) : _tokenLabel(payload.from_token)],
      ['Route', _routeLabel(payload)],
      ['To', payload.recipient_username ? ('@' + payload.recipient_username + ' (' + payload.recipient + ')') : (payload.recipient || payload.phone)],
      ['GCash #', payload.gcash_number],
      ['GCash Name', payload.gcash_name],
      ['Signing', signingLabel(action.login_method)],
      ['Status', action.status]
    ].filter(function (row) { return row[1]; });
    rows.forEach(function (row) {
      dl.appendChild(el('dt', '', row[0]));
      dl.appendChild(el('dd', '', String(row[1])));
    });
    const note = el('p', '', payload.safety_note || 'No transaction will run until you confirm and sign.');
    const isBridge = action.action_type === 'bridge';
    const button = el('button', '', isBridge ? 'Calculating fee…' : 'Confirm action');
    button.type = 'button';
    button.disabled = isBridge;
    button.addEventListener('click', async function () {
      button.disabled = true;
      button.textContent = 'Confirming…';
      try {
        const res = await fetch('/api/ai-agent/actions/' + encodeURIComponent(action.id) + '/confirm', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          const confirmedAction = data.action || action;
          const handled = await continueWalletFlow(confirmedAction, action.id);
          if (handled) {
            button.textContent = 'Confirmed — signing in wallet…';
          } else if (confirmedAction.action_type === 'mobile_load') {
            button.textContent = 'Confirmed — opening Reloadly signing…';
          } else {
            button.textContent = data.message || 'Confirmed — continue in wallet flow';
          }
        } else {
          button.disabled = false;
          button.textContent = data.error || 'Confirm failed';
        }
      } catch (err) {
        button.disabled = false;
        button.textContent = 'Confirm failed';
      }
    });
    card.appendChild(title);
    card.appendChild(dl);
    card.appendChild(note);
    card.appendChild(button);
    // Fetch the same backend estimate used by the /swap bridge tabs before
    // enabling confirmation, so the chat review has no hidden bridge cost.
    _hydrateBridgePreview(action, dl, button);
    if (action && action.id) _actionCards.set(action.id, card);
    return card;
  }

  // The wallet flow broadcasts the pending action id on this element right
  // before signing, so events from manual flows (which carry no action id)
  // can still be attributed to the action the user just confirmed.
  function _ensureAiActionBeacon() {
    let beacon = document.getElementById('gm-ai-current-action');
    if (!beacon) {
      beacon = el('div');
      beacon.id = 'gm-ai-current-action';
      beacon.hidden = true;
      document.body.appendChild(beacon);
    }
    return beacon;
  }

  function _detailActionId(detail) {
    return (detail && detail.actionId) || _activeActionId || null;
  }

  function _resolveCard(messages, actionId) {
    if (actionId && _actionCards.has(actionId)) return _actionCards.get(actionId);
    // Fallback: the most recent review card in this widget (e.g. a manual
    // wallet-page flow confirmed moments earlier).
    const cards = messages.querySelectorAll('.gm-ai-card');
    return cards.length ? cards[cards.length - 1] : null;
  }

  function _markCardSuccess(messages, actionId) {
    const card = _resolveCard(messages, actionId);
    if (!card) return;
    card.innerHTML = '';
    card.appendChild(el('strong', '', '✅ Done — see the result below.'));
  }

  function handleAiProcessing(event) {
    const detail = event.detail || {};
    const text = detail.message;
    if (!text) return;
    document.querySelectorAll('[data-ai-agent] .gm-ai-messages').forEach(function (messages) {
      const msg = addMessage(messages, 'bot', text);
      if (detail.progressKey) msg.setAttribute('data-gm-ai-progress', detail.progressKey);
    });
  }

  function _dismissProgress(messages, progressKey) {
    if (!progressKey) return;
    messages.querySelectorAll('[data-gm-ai-progress="' + progressKey + '"]').forEach(function (msg) {
      msg.remove();
    });
  }

  // The launcher is position:fixed with a hardcoded bottom offset in
  // ai-agent.css, but on the wallet page the bottom nav (2x3 grid of six
  // items) can grow to ~163px tall on phones — taller than the old 92px
  // offset — so the launcher used to float on top of the nav buttons.
  // Measure the real nav height and park the launcher just above it.
  function positionAgentLauncher() {
    const launcher = document.querySelector('.gm-ai-agent');
    if (!launcher) return;
    const nav = document.querySelector('.wallet-bottom-nav');
    if (!nav) return;
    const gap = 12;
    launcher.style.setProperty('--gm-ai-bottom', (nav.getBoundingClientRect().height + gap) + 'px');
  }

  function initAgent(root) {
    const toggle = root.querySelector('.gm-ai-toggle');
    const panel = root.querySelector('.gm-ai-panel');
    const close = root.querySelector('.gm-ai-close');
    const form = root.querySelector('.gm-ai-form');
    const input = root.querySelector('.gm-ai-input');
    const messages = root.querySelector('.gm-ai-messages');

    function setOpen(open) {
      panel.hidden = !open;
      toggle.style.display = open ? 'none' : 'flex';
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) setTimeout(function () { input.focus(); }, 0);
    }

    async function sendAgentMessage(text) {
      const cleanText = (text || '').trim();
      if (!cleanText) return;
      input.value = '';
      addMessage(messages, 'user', cleanText);
      addMessage(messages, 'bot', 'Thinking…');
      const pending = messages.lastElementChild;
      try {
        const res = await fetch('/api/ai-agent/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: cleanText })
        });
        const data = await res.json();
        pending.remove();
        addMessage(messages, 'bot', data.reply || 'Done.', data.action);
      } catch (err) {
        pending.textContent = 'Sorry, the AI agent is unavailable right now.';
      }
    }

    toggle.addEventListener('click', function () { setOpen(true); });
    close.addEventListener('click', function () { setOpen(false); });
    messages.addEventListener('click', function (event) {
      const button = event.target.closest('[data-gm-ai-command]');
      if (!button) return;
      sendAgentMessage(button.getAttribute('data-gm-ai-command') || button.textContent);
    });
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      sendAgentMessage(input.value);
    });
  }


  function handleAiTxSuccess(event) {
    const detail = event.detail || {};
    document.querySelectorAll('[data-ai-agent] .gm-ai-messages').forEach(function (messages) {
      _dismissProgress(messages, detail.progressKey);
      // A succeeded transaction replaces its review card — the result message
      // below is the record now.
      _markCardSuccess(messages, _detailActionId(detail));
      const txHash = detail.txHash || '';
      const shortHash = txHash ? txHash.slice(0, 10) + '…' + txHash.slice(-6) : 'submitted';
      const text = detail.message || ('✅ Transaction sent successfully. Tx hash: ' + shortHash);
      addMessage(messages, 'bot', text);
      if (detail.explorerUrl && messages.lastElementChild) {
        const link = el('a', '', _explorerLinkLabel(detail.explorerUrl));
        link.href = detail.explorerUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.style.color = '#86efac';
        link.style.display = 'block';
        link.style.marginTop = '6px';
        messages.lastElementChild.appendChild(link);
      }
    });
  }

  function handleAiTxFailed(event) {
    const detail = event.detail || {};
    document.querySelectorAll('[data-ai-agent] .gm-ai-messages').forEach(function (messages) {
      _dismissProgress(messages, detail.progressKey);
      const text = detail.message || ('❌ Transaction failed' + (detail.error ? ': ' + detail.error : '.'));
      addMessage(messages, 'bot', text);
    });
  }

  document.addEventListener('goodmarket:ai-tx-processing', handleAiProcessing);
  window.addEventListener('goodmarket:ai-tx-processing', handleAiProcessing);
  document.addEventListener('goodmarket:ai-tx-success', handleAiTxSuccess);
  window.addEventListener('goodmarket:ai-tx-success', handleAiTxSuccess);
  document.addEventListener('goodmarket:ai-tx-failed', handleAiTxFailed);
  window.addEventListener('goodmarket:ai-tx-failed', handleAiTxFailed);

  document.addEventListener('DOMContentLoaded', _ensureAiActionBeacon);

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-ai-agent]').forEach(initAgent);
    positionAgentLauncher();
  });
  // Re-measure when the layout can change under the launcher.
  window.addEventListener('resize', positionAgentLauncher);
  window.addEventListener('orientationchange', positionAgentLauncher);
})();
