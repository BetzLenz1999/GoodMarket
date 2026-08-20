/**
 * P2PWallet — login-method-aware signing helper for the P2P trading page.
 *
 * Mirrors the savings / reloadly approach: it routes signing through whatever
 * login method the user used.
 *   - injected login  -> the injected provider (MiniPay / Trust / MetaMask)
 *   - walletconnect /  -> the GMWalletConnect EIP-1193 bridge provider
 *     goodmarket/manual    (static/js/wc-bridge.js, configured by the page)
 *
 * P2P on-chain user actions (createListing/approve, openOrder,
 * releaseOrder=Approve, cancel, raiseDispute) go through sendTx(). Mark-paid
 * is an off-chain seller notification handled by the backend. The owner
 * (P2P_KEY) admin-review release/refund is server-signed and NOT handled here.
 *
 * Requires ethers v6 and wc-bridge.js to be loaded first.
 */
window.P2PWallet = (function () {
    "use strict";

    var cfg = { wallet: "", chainId: 42220, loginMethod: "" };
    var CELO_RPC_URLS = [
        "https://forno.celo.org",
        "https://1rpc.io/celo",
        "https://celo.publicnode.com",
    ];

    // Celo Mainnet fee-currency adapters MiniPay accepts on eth_sendTransaction.
    var MINIPAY_FEE_CURRENCY = {
        USDM: "0x765DE816845861e75A25fCA122bb6898B8B1282a",
        USDT_ADAPTER: "0x0E2A3e05bc9A16F5292A6170456A710cb89C6f72",
        USDC_ADAPTER: "0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B",
    };

    function configure(o) { Object.assign(cfg, o || {}); }

    function _isPrivyLogin() {
        return String(cfg.loginMethod || "").toLowerCase() === "privy";
    }

    async function _getPrivyProvider(options) {
        if (!_isPrivyLogin()) return null;
        options = options || {};
        var timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : 4000;
        var start = Date.now();
        var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
        while (Date.now() - start < timeoutMs) {
            try {
                var wallets = Array.isArray(window.GMPrivyWallets) ? window.GMPrivyWallets : [];
                var sessionWallet = (cfg.wallet || "").toLowerCase();
                var wallet = wallets.find(function (w) { return (w.address || "").toLowerCase() === sessionWallet; })
                    || wallets.find(function (w) { return w.walletClientType === "privy"; })
                    || wallets[0];
                if (wallet && typeof wallet.getEthereumProvider === "function") {
                    var provider = await wallet.getEthereumProvider();
                    if (provider && typeof provider.request === "function") {
                        provider.__gmPrivyProvider = true;
                        return provider;
                    }
                }
                if (window.GMPrivyReady && !window.GMPrivyAuthenticated && typeof window.GMPrivyLogin === "function" && options.promptLogin) {
                    await window.GMPrivyLogin();
                }
            } catch (err) {
                if (err && (err.code === 4001 || /reject|cancel/i.test(String(err.message || "")))) throw err;
                console.warn("[privy] provider lookup failed:", err);
            }
            await wait(150);
        }
        return null;
    }

    function _preferWc() {
        return (
            typeof GMWalletConnect !== "undefined" &&
            typeof GMWalletConnect.prefersWcSigning === "function" &&
            GMWalletConnect.prefersWcSigning()
        );
    }

    function _collectInjected() {
        var out = [];
        var push = function (p) {
            if (p && typeof p.request === "function" && out.indexOf(p) < 0) out.push(p);
        };
        if (window.ethereum) {
            if (window.ethereum.providers && window.ethereum.providers.length) {
                window.ethereum.providers.forEach(push);
            }
            push(window.ethereum);
        }
        if (window.trustwallet) push(window.trustwallet);
        if (window.trustwallet && window.trustwallet.ethereum) push(window.trustwallet.ethereum);
        return out;
    }

    function _getInjected() {
        // WalletConnect / manual logins must never use an injected wallet — its
        // account differs from the logged-in GoodMarket wallet.
        if (_preferWc() || _isPrivyLogin()) return null;
        try { window.dispatchEvent(new Event("eip6963:requestProvider")); } catch (_) {}
        var providers = _collectInjected();
        if (!providers.length) return null;
        var mini = providers.find(function (p) { return p && p.isMiniPay; });
        if (mini) return mini;
        var mm = providers.find(function (p) { return p && p.isMetaMask && !p.isBraveWallet; });
        return mm || providers[0];
    }

    function isMiniPay() {
        var ep = _getInjected();
        if (ep && ep.isMiniPay) return true;
        if (window.ethereum && window.ethereum.isMiniPay) return true;
        return typeof navigator !== "undefined" && /minipay/i.test(navigator.userAgent || "");
    }

    function _isLocalLogin() {
        return String(cfg.loginMethod || "").toLowerCase() === "local";
    }

    async function getProvider() {
        // Local self-custodial accounts sign with the browser wallet (PIN-decrypted).
        if (_isLocalLogin() && typeof GMLocalWallet !== "undefined") {
            return GMLocalWallet.getProvider();
        }
        var privy = await _getPrivyProvider({ promptLogin: true, timeoutMs: 10000 });
        if (privy) return privy;
        var ep = _getInjected();
        if (ep) return ep;
        if (typeof GMWalletConnect !== "undefined") {
            try { return await GMWalletConnect.getProvider(); } catch (_) {}
        }
        throw new Error(
            _isPrivyLogin()
                ? "Privy wallet is not ready. Please sign in again."
                : "No wallet available. Open in a dApp browser (MiniPay / Trust / MetaMask) or log in with WalletConnect."
        );
    }

    function getReadProvider() {
        return new ethers.FallbackProvider(
            CELO_RPC_URLS.map(function (u) {
                return new ethers.JsonRpcProvider(u, { chainId: cfg.chainId, name: "celo" });
            })
        );
    }

    async function _waitReceipt(ep, txHash, maxAttempts) {
        maxAttempts = maxAttempts || 60;
        for (var i = 0; i < maxAttempts; i++) {
            try {
                var r = await ep.request({ method: "eth_getTransactionReceipt", params: [txHash] });
                if (r) {
                    if (r.status === "0x0") throw new Error("Transaction reverted on-chain.");
                    return r;
                }
            } catch (e) {
                if (e && e.message && /reverted/i.test(e.message)) throw e;
            }
            await new Promise(function (res) { return setTimeout(res, 2000); });
        }
        return null; // may still land; caller can link to CeloScan
    }

    async function _ensureCelo(ep) {
        if (ep.isGoodMarketWcBridge) return; // bridge is Celo-scoped
        try {
            var ch = await ep.request({ method: "eth_chainId" });
            if (parseInt(ch, 16) === cfg.chainId) return;
            var hex = "0x" + cfg.chainId.toString(16);
            try {
                await ep.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
            } catch (_) {
                await ep.request({
                    method: "wallet_addEthereumChain",
                    params: [{
                        chainId: hex, chainName: "Celo Mainnet",
                        nativeCurrency: { name: "CELO", symbol: "CELO", decimals: 18 },
                        rpcUrls: ["https://forno.celo.org"], blockExplorerUrls: ["https://celoscan.io"],
                    }],
                });
            }
        } catch (_) {}
    }


    function _isPrivyEmbeddedProvider(ep, from) {
        if (!ep || !ep.__gmPrivyProvider || !from) return false;
        var wallets = Array.isArray(window.GMPrivyWallets) ? window.GMPrivyWallets : [];
        return wallets.some(function (w) {
            return w
                && w.walletClientType === "privy"
                && (w.address || "").toLowerCase() === String(from).toLowerCase();
        });
    }

    function _privyActionLabel(fn) {
        switch (fn) {
            case "approve": return "Approve G$ spending";
            case "createListing": return "Create P2P sell ad";
            case "openOrder": return "Open P2P order";
            case "cancelListing": return "Cancel P2P sell ad";
            case "cancelOrder": return "Cancel P2P order";
            case "releaseOrder": return "Release escrowed G$";
            case "raiseDispute": return "Raise P2P dispute";
            default: return "Confirm P2P transaction";
        }
    }

    async function _privySendTx(to, data, valueHex, from, fn) {
        if (typeof window.GMPrivySendTransaction !== "function") {
            throw new Error("Privy transaction signing is not ready. Please refresh and try again.");
        }
        var label = _privyActionLabel(fn);
        var receipt = await window.GMPrivySendTransaction(
            {
                to: to,
                data: data,
                value: valueHex || "0x0",
                chainId: cfg.chainId,
            },
            {
                address: from,
                uiOptions: {
                    description: label + " on GoodMarket P2P. Review the details before signing.",
                    buttonText: label,
                    transactionInfo: {
                        title: "GoodMarket P2P",
                        action: label,
                    },
                },
            }
        );
        var txHash = (receipt && (receipt.hash || receipt.transactionHash)) || (typeof receipt === "string" ? receipt : null);
        if (!txHash) throw new Error("Privy did not return a transaction hash.");
        return txHash;
    }

    async function _miniPayTx(ep, to, data, valueHex) {
        var value = valueHex || "0x0";
        var accounts = await ep.request({ method: "eth_requestAccounts" });
        var from = (accounts && accounts[0]) || cfg.wallet;
        var gasHex;
        try {
            var est = await ep.request({ method: "eth_estimateGas", params: [{ from: from, to: to, data: data, value: value }] });
            gasHex = "0x" + (BigInt(est) * 140n / 100n).toString(16);
        } catch (_) { gasHex = "0x7A120"; }
        var attempts = (window.GMMinipayFeeCurrencies && window.GMMinipayFeeCurrencies.orderByBalances)
            ? await window.GMMinipayFeeCurrencies.orderByBalances(ep, from, { includePlain: true })
            : [MINIPAY_FEE_CURRENCY.USDM, MINIPAY_FEE_CURRENCY.USDT_ADAPTER, MINIPAY_FEE_CURRENCY.USDC_ADAPTER, null];
        var lastErr;
        for (var k = 0; k < attempts.length; k++) {
            var p = { from: from, to: to, data: data, value: value, gas: gasHex };
            if (attempts[k]) p.feeCurrency = attempts[k];
            try {
                var txHash = await ep.request({ method: "eth_sendTransaction", params: [p] });
                await _waitReceipt(ep, txHash);
                return txHash;
            } catch (err) {
                lastErr = err;
                var msg = ((err && (err.message || "")) + "").toLowerCase();
                if ((err && err.code === 4001) || /reject|denied|revert/i.test(msg)) throw err;
            }
        }
        throw lastErr || new Error("MiniPay transaction failed");
    }

    /**
     * Send a single contract call.
     * @param {string} to           contract address
     * @param {string} abiFragment  e.g. "function openOrder(uint256 listingId, uint256 amount) returns (uint256)"
     * @param {Array}  args         function args
     * @returns {Promise<string>}   tx hash (after confirmation when possible)
     */
    async function sendTx(to, abiFragment, args, valueHex) {
        var ep = await getProvider();
        var accounts = await ep.request({ method: "eth_requestAccounts" });
        var from = (accounts && accounts[0]) || cfg.wallet;
        if (cfg.wallet && from && from.toLowerCase() !== cfg.wallet.toLowerCase()) {
            throw new Error(
                "Wrong wallet. Switch to " + cfg.wallet.slice(0, 6) + "…" + cfg.wallet.slice(-4) + " and try again."
            );
        }
        var iface = new ethers.Interface([abiFragment]);
        var fn = abiFragment.match(/function (\w+)/)[1];
        var data = iface.encodeFunctionData(fn, args);

        await _ensureCelo(ep);
        if (_isPrivyEmbeddedProvider(ep, from)) {
            var privyTxHash = await _privySendTx(to, data, valueHex, from, fn);
            await _waitReceipt(ep, privyTxHash);
            return privyTxHash;
        }
        if (isMiniPay()) return await _miniPayTx(ep, to, data, valueHex);

        var gasHex;
        try {
            var est = await ep.request({ method: "eth_estimateGas", params: [{ from: from, to: to, data: data, value: valueHex || "0x0" }] });
            gasHex = "0x" + (BigInt(est) * 130n / 100n).toString(16);
        } catch (_) { gasHex = "0x7A120"; }

        var txHash = await ep.request({
            method: "eth_sendTransaction",
            params: [{ from: from, to: to, data: data, value: valueHex || "0x0", gas: gasHex }],
        });
        if (!txHash) throw new Error("Transaction failed");
        await _waitReceipt(ep, txHash);
        return txHash;
    }

    /**
     * Fetch a tx receipt via public RPC and decode an event by name from a
     * given contract ABI. Returns the decoded args object, or null.
     */
    async function decodeEvent(txHash, abi, eventName) {
        try {
            var rp = getReadProvider();
            var receipt = await rp.getTransactionReceipt(txHash);
            if (!receipt) return null;
            var iface = new ethers.Interface(abi);
            for (var i = 0; i < receipt.logs.length; i++) {
                try {
                    var parsed = iface.parseLog(receipt.logs[i]);
                    if (parsed && parsed.name === eventName) return parsed.args;
                } catch (_) {}
            }
        } catch (_) {}
        return null;
    }

    return {
        configure: configure,
        sendTx: sendTx,
        getProvider: getProvider,
        getReadProvider: getReadProvider,
        decodeEvent: decodeEvent,
        isMiniPay: isMiniPay,
    };
})();
