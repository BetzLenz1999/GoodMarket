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

  function renderActionCard(action) {
    const card = el('div', 'gm-ai-card');
    const title = el('strong', '', 'Review before signing');
    const dl = document.createElement('dl');
    const payload = action.payload || {};
    const rows = [
      ['Action', action.action_type],
      ['Amount', payload.flow_rate_per_day ? (payload.flow_rate_per_day + ' G$/day') : (payload.amount || payload.fiat_amount)],
      ['Token', payload.token || payload.from_token],
      ['To', payload.recipient_username ? ('@' + payload.recipient_username + ' (' + payload.recipient + ')') : (payload.recipient || payload.to_token || payload.phone)],
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
    const button = el('button', '', 'Confirm action');
    button.type = 'button';
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
        const link = el('a', '', 'View on Celoscan ↗');
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
  });
})();
