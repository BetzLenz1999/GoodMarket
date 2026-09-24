
/* GoodMarket Chicken Farm — page logic.
 *
 * Extracted from templates/farming.html so the markup stays readable and the
 * logic can be reasoned about (and tested) on its own. Per-request values come
 * from window.GM_FARM_BOOT, set inline by the template.
 *
 * Signing rules follow the rest of the app:
 *   - local logins sign with the PIN-decrypted in-app wallet (GMLocalWallet);
 *     an injected MetaMask is a DIFFERENT account and must never be used.
 *   - WalletConnect logins sign through the WC bridge.
 *   - everyone else uses the injected provider, bound to the account that
 *     matches the session wallet (multi-account wallets otherwise sign with
 *     whatever is selected).
 * Reads (balances, farm state, history reconciliation) go through a public
 * Celo RPC so they never pop a wallet prompt and never lag behind the phone's
 * node.
 */
(function () {
    "use strict";

    var boot = window.GM_FARM_BOOT || {};
    var WALLET = String(boot.wallet || "");
    var LOGIN_METHOD = String(boot.loginMethod || "").toLowerCase();
    var FARMING_CONTRACT = String(boot.farmingContract || "");
    var GD_CONTRACT = String(boot.gdContract || "0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A");
    var CHAIN_ID = Number(boot.chainId || 42220);
    var CHAIN_HEX = "0x" + CHAIN_ID.toString(16);
    var CELO_RPC = String(boot.celoRpc || "https://forno.celo.org");
    var CELO_RPC_FALLBACKS = Array.isArray(boot.celoRpcFallbacks) && boot.celoRpcFallbacks.length
        ? boot.celoRpcFallbacks
        : [CELO_RPC, "https://rpc.ankr.com/celo", "https://celo.drpc.org"];
    var CFG = boot.config || {};
    var MIN_FARM = Number(CFG.min_farm_gd || 1000);
    var CHICKEN_PRICE = Number(CFG.chicken_price_gd || 100);
    var FARM_DAYS = Number(CFG.farm_days || 30);
    var MONTHLY_PROFIT_PERCENT = Number(CFG.monthly_profit_percent || 10);

    var GD_DECIMALS = 18;
    var HISTORY = window.GMFarmHistory;
    var readProvider = null;
    var farmState = null;
    var tickTimer = null;
    var busy = false;

    // getFarm() returns the full farm state, so the per-field view helpers
    // (pendingEggs / pendingEggValue / maxMonthlyProfit) are not declared here.
    var FARM_ABI = [
        "function startFarm(uint256 amount)",
        "function sellEggs()",
        "function closeFarm()",
        "function rewardPool() view returns (uint256)",
        "function getFarm(address user) view returns (uint256 principal, uint256 chickens, uint256 startedAt, uint256 lastEggSoldAt, uint256 unlocksAt, uint256 claimedProfit, bool active, bool isMature, uint256 eggsReady, uint256 eggValueGd, uint256 totalValueAtMaturity)",
    ];
    var GD_ABI = [
        "function approve(address spender, uint256 amount) returns (bool)",
        "function allowance(address owner, address spender) view returns (uint256)",
        "function balanceOf(address account) view returns (uint256)",
    ];

    var $ = function (id) { return document.getElementById(id); };
    var _toLower = function (v) { return String(v || "").toLowerCase(); };

    // ── pure helpers (exported for tests) ───────────────────────────────────

    // A farm amount is valid when it clears the minimum and buys whole
    // chickens — the contract rejects anything else, so catch it before the
    // wallet prompt instead of letting a revert look like a network error.
    function validateFarmAmount(raw) {
        var amount = Number(raw);
        if (!isFinite(amount) || amount <= 0) {
            return { ok: false, error: "Enter how many G$ you want to farm." };
        }
        if (amount < MIN_FARM) {
            return { ok: false, error: "Minimum farm is " + MIN_FARM + " G$ (" + Math.floor(MIN_FARM / CHICKEN_PRICE) + " chickens)." };
        }
        if (amount % CHICKEN_PRICE !== 0) {
            return { ok: false, error: "Amount must be a multiple of " + CHICKEN_PRICE + " G$ so it buys whole chickens." };
        }
        return { ok: true, amount: amount, chickens: Math.floor(amount / CHICKEN_PRICE) };
    }

    function projectedMonthlyProfit(principalGd) {
        var p = Number(principalGd);
        if (!isFinite(p) || p <= 0) return 0;
        return Math.round(p * (MONTHLY_PROFIT_PERCENT / 100) * 100) / 100;
    }

    // Copy shown after a successful close. The user's core question is "did my
    // G$ arrive?" — so the message names the exact amount sent and the hash.
    function describeCloseSuccess(amountGd, hash) {
        return "🎉 Congratulations — your farm is now closed and " +
            HISTORY.formatGd(amountGd) + " G$ has been sent to your wallet.";
    }

    function describeSellSuccess(amountGd) {
        return "✅ Eggs sold! " + HISTORY.formatGd(amountGd) + " G$ was sent to your wallet.";
    }

    function eggValueLabel(eggValue) {
        return HISTORY.formatWei(eggValue) + " G$";
    }

    // ── read provider (public RPC, no wallet prompt) ────────────────────────

    function getReadProvider() {
        if (readProvider) return readProvider;
        if (typeof ethers === "undefined") return null;
        var urls = [];
        CELO_RPC_FALLBACKS.forEach(function (u) {
            if (u && urls.indexOf(u) === -1) urls.push(u);
        });
        if (!urls.length) return null;

        // Real failover: forno regularly returns transient errors, and a
        // receipt read that silently fails is exactly what makes a user think
        // their G$ never arrived. quorum 1 keeps a single fast provider in
        // normal operation while allowing a switch on failure.
        if (typeof ethers.FallbackProvider === "function" && urls.length > 1) {
            try {
                var entries = urls.map(function (u, i) {
                    return {
                        provider: new ethers.JsonRpcProvider(u),
                        priority: i + 1,
                        weight: 1,
                        stallTimeout: 2000,
                    };
                });
                readProvider = new ethers.FallbackProvider(entries, 1);
                return readProvider;
            } catch (_) {
                readProvider = null;
            }
        }
        try {
            readProvider = new ethers.JsonRpcProvider(urls[0]);
        } catch (_) {
            readProvider = null;
        }
        return readProvider;
    }

    // ── signer resolution (mirrors swap.html / lotto.html) ──────────────────

    var isLocal = function () { return LOGIN_METHOD === "local"; };
    var prefersWc = function () {
        return typeof GMWalletConnect !== "undefined" &&
            typeof GMWalletConnect.prefersWcSigning === "function" &&
            GMWalletConnect.prefersWcSigning();
    };

    window.__farmEip6963Providers = window.__farmEip6963Providers || [];
    (function _initEip6963() {
        try {
            window.addEventListener("eip6963:announceProvider", function (event) {
                var detail = event && event.detail;
                if (!detail || !detail.provider) return;
                var uuid = detail.info && detail.info.uuid;
                var already = window.__farmEip6963Providers.find(function (d) {
                    return (d.info && d.info.uuid && uuid && d.info.uuid === uuid) || d.provider === detail.provider;
                });
                if (!already) window.__farmEip6963Providers.push(detail);
            });
            window.dispatchEvent(new Event("eip6963:requestProvider"));
        } catch (_) {}
    })();

    function _coerceProvider(candidate) {
        if (!candidate) return null;
        if (typeof candidate.request === "function") return candidate;
        if (candidate.ethereum && typeof candidate.ethereum.request === "function") return candidate.ethereum;
        if (candidate.provider && typeof candidate.provider.request === "function") return candidate.provider;
        return null;
    }

    function _collectProviders() {
        var out = [];
        var push = function (p) {
            var provider = _coerceProvider(p);
            if (provider && out.indexOf(provider) === -1) out.push(provider);
        };
        if (window.ethereum) {
            if (Array.isArray(window.ethereum.providers)) window.ethereum.providers.forEach(push);
            push(window.ethereum);
        }
        if (window.trustwallet) push(window.trustwallet);
        if (window.trustWallet) push(window.trustWallet);
        (window.__farmEip6963Providers || []).forEach(function (d) { push(d.provider); });
        return out;
    }

    function _isMobile() {
        return /android|iphone|ipad|ipod|minipay|metamask|trust|trustwallet/i
            .test((navigator.userAgent || "").toLowerCase());
    }

    function _awaitProviders(timeoutMs) {
        if (prefersWc() || isLocal()) return Promise.resolve([]);
        var budget = typeof timeoutMs === "number" ? timeoutMs : (_isMobile() ? 3000 : 900);
        var start = Date.now();
        var providers = _collectProviders();
        if (providers.length) return Promise.resolve(providers);
        return new Promise(function (resolve) {
            (function poll() {
                try { window.dispatchEvent(new Event("eip6963:requestProvider")); } catch (_) {}
                providers = _collectProviders();
                if (providers.length) return resolve(providers);
                if (Date.now() - start >= budget) return resolve([]);
                setTimeout(poll, 120);
            })();
        });
    }

    function _isUserRejection(err) {
        var code = err && err.code;
        if (code === 4001 || code === 5000) return true;
        var msg = String((err && (err.shortMessage || err.message)) || "").toLowerCase();
        return msg.indexOf("user rejected") !== -1 || msg.indexOf("user denied") !== -1 ||
            msg.indexOf("cancelled") !== -1 || msg.indexOf("canceled") !== -1;
    }

    function _localProvider() {
        if (!isLocal() || typeof GMLocalWallet === "undefined") return Promise.resolve(null);
        if (!GMLocalWallet.isUnlocked()) {
            if (typeof window._lwOpenUnlockModal !== "function") {
                return Promise.reject(new Error("Please unlock your wallet and try again."));
            }
            return Promise.resolve(window._lwOpenUnlockModal()).then(function () {
                if (!GMLocalWallet.isUnlocked()) {
                    throw new Error("Your wallet is still locked. Please enter your PIN to sign.");
                }
                return GMLocalWallet.getProvider();
            });
        }
        return Promise.resolve(GMLocalWallet.getProvider());
    }

    function resolveSigner() {
        if (isLocal()) {
            return _localProvider().then(function (provider) {
                var p = new ethers.BrowserProvider(provider);
                return p.getSigner().then(function (signer) {
                    if (_toLower(signer.address) !== _toLower(WALLET)) {
                        throw new Error("Wrong wallet connected. Please use your GoodMarket wallet.");
                    }
                    return { signer: signer, provider: provider };
                });
            });
        }

        return _awaitProviders().then(function (providers) {
            if (!providers.length) {
                if (prefersWc()) {
                    return GMWalletConnect.getProvider().then(function (wcProvider) {
                        var p = new ethers.BrowserProvider(wcProvider);
                        return p.getSigner().then(function (signer) {
                            if (_toLower(signer.address) !== _toLower(WALLET)) {
                                throw new Error("Wrong WalletConnect wallet connected. Please switch to your GoodMarket wallet.");
                            }
                            return { signer: signer, provider: wcProvider };
                        });
                    });
                }
                throw new Error("No wallet detected. Open this page in MetaMask, Trust Wallet or another Celo wallet.");
            }

            // Bind to the account that matches the session wallet — a
            // multi-account wallet otherwise signs with whatever is selected.
            var wanted = _toLower(WALLET);

            return (function tryProvider(index, lastErr) {
                if (index >= providers.length) {
                    throw lastErr || new Error("Could not connect to your wallet. Please try again.");
                }
                var provider = providers[index];
                return Promise.resolve()
                    .then(function () {
                        return provider.request({ method: "eth_requestAccounts" })
                            .catch(function (reqErr) {
                                if (_isUserRejection(reqErr)) throw reqErr;
                                return provider.request({ method: "eth_accounts" }).catch(function () { return []; });
                            });
                    })
                    .then(function (accounts) {
                        accounts = accounts || [];
                        var match = accounts.find(function (a) { return _toLower(a) === wanted; });
                        if (!match) {
                            // Try the next discovered provider before reporting a
                            // wrong-wallet error — mobile dApp browsers inject
                            // several (MetaMask + Trust + MiniPay) at once.
                            var next = accounts.length
                                ? new Error("Wrong wallet connected. Please switch to your GoodMarket wallet (" +
                                    WALLET.slice(0, 6) + "…) before continuing.")
                                : (lastErr || new Error("No wallet account available. Please unlock your wallet and try again."));
                            return tryProvider(index + 1, next);
                        }
                        var p = new ethers.BrowserProvider(provider);
                        return p.getSigner(match).then(function (signer) {
                            return { signer: signer, provider: provider };
                        });
                    })
                    .catch(function (err) {
                        if (_isUserRejection(err) || String(err.message || "").indexOf("Wrong wallet") === 0) throw err;
                        return tryProvider(index + 1, err);
                    });
            })(0, null);
        });
    }

    function ensureCelo(provider) {
        if (!provider || !provider.request) return Promise.resolve();
        return provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] })
            .catch(function (err) {
                if (err && (err.code === 4902 || String(err.message || "").indexOf("Unrecognized chain") !== -1)) {
                    return provider.request({
                        method: "wallet_addEthereumChain",
                        params: [{
                            chainId: CHAIN_HEX,
                            chainName: "Celo Mainnet",
                            rpcUrls: [CELO_RPC],
                            nativeCurrency: { name: "CELO", symbol: "CELO", decimals: 18 },
                            blockExplorerUrls: ["https://celoscan.io"],
                        }],
                    });
                }
                // 4001 here means the user declined the switch; the signature
                // itself will surface it. Not fatal to the flow.
                return null;
            });
    }

    // ── transaction tracking ────────────────────────────────────────────────

    // Record a transaction that has actually been broadcast. Called AFTER the
    // wallet returns a hash so a rejected signature never leaves a phantom row
    // — the history is a record of on-chain activity, not of attempted clicks.
    function trackTx(action, hash, opts) {
        opts = opts || {};
        var entry = HISTORY.add({
            hash: hash,
            action: action,
            actionLabel: opts.actionLabel || HISTORY.ACTION_LABELS[action] || action,
            amountLabel: opts.amountLabel || "",
            wallet: WALLET,
            status: "pending",
            note: opts.note || "",
        });
        renderHistory();
        return entry;
    }

    // Sum the G$ delivered TO this wallet in a receipt's Transfer logs. This is
    // what actually answers "did the G$ arrive?" — an ERC-20 transfer emits
    // Transfer(from, to, value) and the wallet is topic 2.
    function sumGdReceived(receipt, wallet) {
        var total = 0n;
        if (!receipt || !Array.isArray(receipt.logs)) return "0";
        var transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
        var walletTopic = "0x" + _toLower(wallet).replace(/^0x/, "").padStart(64, "0");
        var gd = _toLower(GD_CONTRACT);
        receipt.logs.forEach(function (log) {
            try {
                if (_toLower(log.address) !== gd) return;
                if (!log.topics || _toLower(log.topics[0]) !== transferTopic) return;
                if (_toLower(log.topics[2]) !== walletTopic) return;
                total += BigInt(log.data);
            } catch (_) {}
        });
        return total.toString();
    }

    // Mark a tracked tx from its receipt. Shared by the live flow and the
    // page-load reconciliation pass so both settle history identically.
    function settleFromReceipt(entry, receipt) {
        if (!receipt) return;
        if (receipt.status === 0 || receipt.status === "0x0") {
            HISTORY.update(entry.id, {
                status: "failed",
                error: "Transaction reverted on-chain.",
                blockNumber: receipt.blockNumber != null ? receipt.blockNumber : null,
            });
            return;
        }
        var received = sumGdReceived(receipt, WALLET);
        HISTORY.update(entry.id, {
            status: "confirmed",
            confirmedAt: Date.now(),
            blockNumber: receipt.blockNumber != null ? receipt.blockNumber : null,
            receivedWei: received,
            error: "",
        });
    }

    function waitForReceipt(hash, onTick) {
        var rp = getReadProvider();
        if (!rp || !HISTORY.isOnchainHash(hash)) return Promise.resolve(null);
        var tries = 0;
        return (function poll() {
            return rp.getTransactionReceipt(hash).then(function (receipt) {
                if (receipt) return receipt;
                tries += 1;
                if (tries >= 50) return null; // ~2.5 min then leave it pending
                if (typeof onTick === "function") onTick(tries);
                return new Promise(function (r) { setTimeout(r, 3000); }).then(poll);
            }).catch(function () {
                tries += 1;
                if (tries >= 50) return null;
                return new Promise(function (r) { setTimeout(r, 3000); }).then(poll);
            });
        })();
    }

    // Page load: any entry left "pending" (the user closed the tab, or the
    // RPC was busy) is re-checked against the chain so history never lies.
    function reconcilePending() {
        var rp = getReadProvider();
        if (!rp) return Promise.resolve();
        var pending = HISTORY.pending();
        if (!pending.length) return Promise.resolve();
        return Promise.all(pending.map(function (entry) {
            return rp.getTransactionReceipt(entry.hash).then(function (receipt) {
                if (receipt) settleFromReceipt(entry, receipt);
            }).catch(function () {});
        })).then(renderHistory);
    }

    // ── contract calls ──────────────────────────────────────────────────────

    function farmContract(signer) {
        return new ethers.Contract(FARMING_CONTRACT, FARM_ABI, signer);
    }

    function gdContract(runner) {
        return new ethers.Contract(GD_CONTRACT, GD_ABI, runner);
    }

    function _errMessage(err) {
        var formatted = (window.GMTxError && typeof GMTxError.format === "function")
            ? GMTxError.format(err) : "";
        if (formatted) return formatted;
        return (err && (err.shortMessage || err.message)) || "Something went wrong.";
    }

    function setStatus(message, type) {
        var el = $("farmStatus");
        if (!el) return;
        el.textContent = message;
        el.className = "status" + (type ? " " + type : "");
    }

    function setProgress(step, total) {
        var bar = $("txProgress");
        if (!bar) return;
        if (!step) { bar.classList.remove("show"); bar.textContent = ""; return; }
        bar.classList.add("show");
        bar.textContent = "";
        var span = document.createElement("span");
        span.className = "spinner";
        bar.appendChild(span);
        var label = document.createElement("span");
        label.textContent = "Step " + step + " of " + total;
        bar.appendChild(label);
    }

    function toast(message, type) {
        var t = $("farmToast");
        if (!t) return;
        t.textContent = message;
        t.className = "farm-toast " + (type || "info") + " show";
        clearTimeout(t._delay);
        t._delay = setTimeout(function () { t.classList.remove("show"); }, 3600);
    }

    function updateActionState() {
        var active = Boolean(farmState && farmState.active);
        var hasContract = Boolean(FARMING_CONTRACT);
        var eggsReady = active && farmState.eggValue > 0n;
        var poolCovers = active && farmState.pool >= farmState.eggValue;
        var canSell = hasContract && eggsReady && poolCovers;
        var canClose = hasContract && active && farmState.mature && poolCovers;

        var sellBtn = $("sellEggsBtn");
        var closeBtn = $("closeFarmBtn");
        if (sellBtn) sellBtn.disabled = !canSell || busy;
        if (closeBtn) closeBtn.disabled = !canClose || busy;
        var startBtn = $("startFarmBtn");
        if (startBtn) startBtn.disabled = !hasContract || active || busy;

        var banner = $("farmStatusBanner");
        if (banner) {
            if (!active) banner.textContent = "No active farm yet — start one below. 🐣";
            else if (!farmState.mature) banner.textContent = "Your chickens are laying eggs. You can sell eggs any time.";
            else banner.textContent = "Your farm is mature! Close it to get your principal + egg rewards. 💰";
        }
    }

    function blockReason(action) {
        if (!FARMING_CONTRACT) return "The farming contract is not configured yet. Please try again later.";
        if (busy) return "Please wait for the current transaction to finish.";
        if (!farmState || !farmState.active) return "No active farm found. Tap Refresh status first.";
        if (action === "close" && !farmState.mature) return "This farm is still growing and cannot be closed yet.";
        // A matured farm whose profit was already sold off still closes — the
        // contract returns the principal with a 0 final profit. Only selling
        // needs eggs to exist.
        if (action === "sell" && farmState.eggValue === 0n) {
            return "There are no egg rewards ready yet. Chickens produce 1 egg per day.";
        }
        if (farmState.pool < farmState.eggValue) {
            var shortage = farmState.eggValue - farmState.pool;
            return "Not opened because it would fail: the reward pool needs " +
                HISTORY.formatWei(shortage) + " more G$. Please ask an admin to fund the pool, then refresh.";
        }
        return "";
    }

    // ── actions ─────────────────────────────────────────────────────────────

    function startFarm() {
        if (busy) return Promise.resolve();
        if (!FARMING_CONTRACT) return Promise.resolve(setStatus("The farming contract is not configured yet.", "error"));
        var check = validateFarmAmount(($("farmAmount") || {}).value);
        if (!check.ok) return Promise.resolve(setStatus(check.error, "error"));

        var amountWei;
        try { amountWei = ethers.parseUnits(String(check.amount), GD_DECIMALS); }
        catch (_) { return Promise.resolve(setStatus("Invalid amount.", "error")); }

        busy = true; updateActionState();
        setStatus("Preparing " + check.chickens + " chickens (" + HISTORY.formatGd(check.amount) + " G$)…");
        setProgress(0, 0);

        var resolved, reader;
        return resolveSigner().then(function (r) {
            resolved = r;
            return ensureCelo(r.provider);
        }).then(function () {
            reader = getReadProvider();
            if (!reader) throw new Error("Could not reach the Celo network. Please check your connection.");
            return gdContract(reader).balanceOf(WALLET);
        }).then(function (balance) {
            if (BigInt(balance) < amountWei) {
                var err = new Error("Not enough G$ in your wallet. You need " +
                    HISTORY.formatGd(check.amount) + " G$ but have " +
                    HISTORY.formatWei(balance) + " G$.");
                if (window.GMTxError && typeof GMTxError.asFriendly === "function") {
                    // Prevents format() from replacing this with a wallet-pattern
                    // message — the exact shortfall is the actionable part.
                    GMTxError.asFriendly(err);
                }
                throw err;
            }
            return gdContract(reader).allowance(WALLET, FARMING_CONTRACT);
        }).then(function (allowance) {
            if (BigInt(allowance) >= amountWei) return null;
            // Step 1/2: approve. Tracked so the user can always see the hash.
            setProgress(1, 2);
            setStatus("Step 1 of 2 — approve G$ spending. Confirm in your wallet…");
            var gd = gdContract(resolved.signer);
            return gd.approve(FARMING_CONTRACT, amountWei).then(function (tx) {
                var entry = trackTx("approve", tx.hash, { amountLabel: HISTORY.formatGd(check.amount) + " G$", note: "G$ spending approval" });
                setProgress(1, 2);
                setStatus("Approval sent. Waiting for confirmation… Tx: " + HISTORY.shortHash(tx.hash));
                return waitForReceipt(tx.hash).then(function (receipt) {
                    if (receipt) {
                        settleFromReceipt(entry, receipt);
                    } else {
                        HISTORY.update(entry.id, { note: "Approval submitted — confirming" });
                    }
                    renderHistory();
                });
            });
        }).then(function () {
            setProgress(2, 2);
            setStatus("Step 2 of 2 — start your farm. Confirm in your wallet…");
            var farm = farmContract(resolved.signer);
            return farm.startFarm(amountWei).then(function (tx) {
                var entry = trackTx("startFarm", tx.hash, {
                    amountLabel: HISTORY.formatGd(check.amount) + " G$",
                    note: check.chickens + " chickens",
                });
                setStatus("Farm start sent. Waiting for confirmation… Tx: " + HISTORY.shortHash(tx.hash));
                return waitForReceipt(tx.hash).then(function (receipt) {
                    if (receipt) settleFromReceipt(entry, receipt);
                    renderHistory();
                    setProgress(0, 0);
                    if (receipt && (receipt.status === 0 || receipt.status === "0x0")) {
                        setStatus("The farm transaction reverted on-chain. See history below.", "error");
                        return;
                    }
                    setStatus("✅ Farm started with " + check.chickens + " chickens! " +
                        HISTORY.formatGd(check.amount) + " G$ is now locked until maturity.", "ok");
                    toast("🐣 " + check.chickens + " chickens are now farming!", "success");
                    return refreshFarm();
                });
            });
        }).catch(function (err) {
            setProgress(0, 0);
            if (_isUserRejection(err)) {
                setStatus("You cancelled the wallet request.", "error");
            } else {
                setStatus(_errMessage(err), "error");
            }
        }).then(function () {
            busy = false;
            updateActionState();
        });
    }

    function sellEggs() {
        if (busy) return Promise.resolve();
        var reason = blockReason("sell");
        if (reason) return Promise.resolve(setStatus(reason, "error"));
        var soldEggs = farmState.eggs;
        var soldValue = farmState.eggValue;

        busy = true; updateActionState();
        setStatus("Confirm selling your eggs in your wallet…");
        setProgress(1, 1);

        var resolved;
        return resolveSigner().then(function (r) {
            resolved = r;
            return ensureCelo(r.provider);
        }).then(function () {
            var farm = farmContract(resolved.signer);
            return farm.sellEggs().then(function (tx) {
                var entry = trackTx("sellEggs", tx.hash, {
                    amountLabel: HISTORY.formatWei(soldValue) + " G$",
                    note: soldEggs.toString() + " eggs",
                });
                setStatus("Eggs sale sent. Waiting for confirmation… Tx: " + HISTORY.shortHash(tx.hash));
                return waitForReceipt(tx.hash).then(function (receipt) {
                    setProgress(0, 0);
                    if (!receipt) {
                        setStatus("Eggs sale submitted. Confirmation is still pending — it will update in your history below.", "info");
                        return renderHistory();
                    }
                    settleFromReceipt(entry, receipt);
                    renderHistory();
                    if (receipt.status === 0 || receipt.status === "0x0") {
                        setStatus("The sale reverted on-chain. Your eggs are still safe — see history below.", "error");
                        return refreshFarm();
                    }
                    var received = sumGdReceived(receipt, WALLET);
                    var paidGd = HISTORY.formatWei(received);
                    setStatus(describeSellSuccess(paidGd) + " Tx: " + HISTORY.shortHash(tx.hash), "ok");
                    toast("🥚 " + paidGd + " G$ received!", "success");
                    return refreshFarm();
                });
            });
        }).catch(function (err) {
            setProgress(0, 0);
            setStatus(_isUserRejection(err) ? "You cancelled the wallet request." : _errMessage(err), "error");
        }).then(function () {
            busy = false;
            updateActionState();
        });
    }

    function closeFarm() {
        if (busy) return Promise.resolve();
        var reason = blockReason("close");
        if (reason) return Promise.resolve(setStatus(reason, "error"));
        var expectedPrincipal = farmState.principal;
        var expectedProfit = farmState.eggValue;
        var expectedTotal = expectedPrincipal + expectedProfit;

        busy = true; updateActionState();
        setStatus("Confirm closing your farm in your wallet…");
        setProgress(1, 1);

        var resolved;
        return resolveSigner().then(function (r) {
            resolved = r;
            return ensureCelo(r.provider);
        }).then(function () {
            var farm = farmContract(resolved.signer);
            return farm.closeFarm().then(function (tx) {
                var entry = trackTx("closeFarm", tx.hash, {
                    amountLabel: HISTORY.formatWei(expectedTotal) + " G$",
                    note: "Principal + egg rewards",
                });
                setStatus("Farm closing sent. Waiting for confirmation… Tx: " + HISTORY.shortHash(tx.hash));
                return waitForReceipt(tx.hash).then(function (receipt) {
                    setProgress(0, 0);
                    if (!receipt) {
                        setStatus("Farm close submitted. Confirmation is still pending — it will update in your history below.", "info");
                        return renderHistory();
                    }
                    settleFromReceipt(entry, receipt);
                    renderHistory();
                    if (receipt.status === 0 || receipt.status === "0x0") {
                        setStatus("The close transaction reverted on-chain. Your farm is still active — see history below.", "error");
                        return refreshFarm();
                    }
                    var received = sumGdReceived(receipt, WALLET);
                    var paidGd = HISTORY.formatWei(received);
                    HISTORY.update(entry.id, { amountLabel: paidGd + " G$", note: "Paid out to wallet" });
                    setStatus(describeCloseSuccess(paidGd) + " Tx: " + HISTORY.shortHash(tx.hash), "ok");
                    showCloseModal(paidGd, tx.hash);
                    return refreshFarm();
                });
            });
        }).catch(function (err) {
            setProgress(0, 0);
            setStatus(_isUserRejection(err) ? "You cancelled the wallet request." : _errMessage(err), "error");
        }).then(function () {
            busy = false;
            updateActionState();
        });
    }

    // ── rendering ───────────────────────────────────────────────────────────

    function showCloseModal(amountGd, hash) {
        var modal = $("closeSuccessModal");
        if (!modal) return;
        var amountEl = $("closeSuccessAmount");
        if (amountEl) amountEl.textContent = HISTORY.formatGd(amountGd) + " G$";
        var linkEl = $("closeSuccessTx");
        if (linkEl) {
            var url = HISTORY.celoscanUrl(hash);
            if (url) {
                linkEl.href = url;
                linkEl.textContent = HISTORY.shortHash(hash, 14);
                linkEl.parentElement.style.display = "";
            } else {
                linkEl.parentElement.style.display = "none";
            }
        }
        modal.classList.add("open");
    }

    function closeCloseModal() {
        var modal = $("closeSuccessModal");
        if (modal) modal.classList.remove("open");
    }

    function renderHistory() {
        var list = $("farmHistoryList");
        if (!list) return;
        var items = HISTORY.all();
        var empty = $("farmHistoryEmpty");
        if (!items.length) {
            list.innerHTML = "";
            if (empty) empty.style.display = "";
            return;
        }
        if (empty) empty.style.display = "none";
        list.innerHTML = items.map(function (e) {
            var status = e.status;
            var chip, chipClass;
            if (status === "confirmed") { chip = "✅ Confirmed"; chipClass = "ok"; }
            else if (status === "failed") { chip = "❌ Failed"; chipClass = "error"; }
            else { chip = "⏳ Pending"; chipClass = "pending"; }

            var url = HISTORY.celoscanUrl(e.hash);
            var hashHtml = url
                ? '<a class="tx-hash" href="' + url + '" target="_blank" rel="noopener">' + HISTORY.shortHash(e.hash, 12) + ' ↗</a>'
                : '<span class="tx-hash muted">No hash yet</span>';

            var receivedNote = "";
            // Only show "G$ received" for actions that pay the user. Start-farm
            // and approve move G$ TO the contract, so a 0 there would read as a
            // failure when nothing is wrong.
            var paysUser = e.action === "closeFarm" || e.action === "sellEggs";
            if (status === "confirmed" && paysUser && e.receivedWei) {
                receivedNote = '<div class="tx-received">G$ received: ' + HISTORY.formatWei(e.receivedWei) + ' G$</div>';
            }
            var errorNote = e.error ? '<div class="tx-error">' + escapeHtml(e.error) + '</div>' : "";

            return '<div class="tx-row ' + chipClass + '">' +
                '<div class="tx-main">' +
                    '<div class="tx-top"><span class="tx-action">' + escapeHtml(e.actionLabel) + '</span>' +
                    '<span class="tx-status ' + chipClass + '">' + chip + '</span></div>' +
                    '<div class="tx-meta">' +
                        (e.amountLabel ? '<span class="tx-amount">' + escapeHtml(e.amountLabel) + '</span>' : '') +
                        '<span class="tx-time">' + HISTORY.formatTime(e.confirmedAt || e.createdAt) + '</span>' +
                    '</div>' +
                    receivedNote + errorNote +
                    '<div class="tx-foot">' + hashHtml + '</div>' +
                '</div>' +
            '</div>';
        }).join("");
    }

    function escapeHtml(value) {
        return String(value == null ? "" : value)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function updateChickensToBuy() {
        var input = $("farmAmount");
        var out = $("chickensToBuy");
        if (!input || !out) return;
        var amount = Number(input.value || 0);
        var chickens = Math.floor(amount / CHICKEN_PRICE);
        out.textContent = isFinite(chickens) && chickens > 0 ? chickens.toLocaleString() : "0";
        var projected = $("projectedProfit");
        if (projected) {
            var profit = projectedMonthlyProfit(amount);
            projected.textContent = HISTORY.formatGd(profit) + " G$";
        }
        var payout = $("projectedPayout");
        if (payout) {
            payout.textContent = HISTORY.formatGd(amount + projectedMonthlyProfit(amount)) + " G$";
        }
    }

    function renderFarm() {
        var active = Boolean(farmState && farmState.active);
        var principalEl = $("principalValue");
        var chickenEl = $("chickenCount");
        var eggsEl = $("eggsReady");
        var eggValueEl = $("eggValue");
        var poolEl = $("rewardPoolValue");
        var statusEl = $("farmPhaseValue");
        var progressFill = $("cycleProgressFill");
        var progressLabel = $("cycleProgressLabel");

        if (chickenEl) chickenEl.textContent = active ? farmState.chickens.toString() : "—";
        if (principalEl) principalEl.textContent = active ? HISTORY.formatWei(farmState.principal) + " G$" : "—";
        if (eggsEl) eggsEl.textContent = active ? farmState.eggs.toString() : "—";
        if (eggValueEl) eggValueEl.textContent = active ? eggValueLabel(farmState.eggValue) : "—";
        if (poolEl) poolEl.textContent = HISTORY.formatWei(farmState.pool) + " G$";

        if (statusEl) {
            if (!active) statusEl.textContent = "No farm";
            else if (farmState.mature) statusEl.textContent = "Mature 🌾";
            else statusEl.textContent = "Growing 🌱";
        }

        if (progressFill && progressLabel) {
            if (!active) {
                progressFill.style.width = "0%";
                progressLabel.textContent = "Start a farm to begin your " + FARM_DAYS + "-day cycle.";
            } else {
                var now = Math.floor(Date.now() / 1000);
                var span = farmState.unlocksAt - farmState.startedAt;
                var done = Math.min(Math.max(now - farmState.startedAt, 0), span);
                var pct = span > 0 ? Math.round((done / span) * 100) : 100;
                progressFill.style.width = pct + "%";
                var left = Math.max(farmState.unlocksAt - now, 0);
                var days = Math.floor(left / 86400);
                var hours = Math.floor((left % 86400) / 3600);
                progressLabel.textContent = farmState.mature
                    ? "Cycle complete — ready to close!"
                    : pct + "% · " + days + "d " + hours + "h until maturity";
            }
        }
    }

    function refreshFarm() {
        if (!FARMING_CONTRACT) {
            setStatus("The farming contract is not configured yet. Please try again later.", "error");
            return Promise.resolve();
        }
        var reader = getReadProvider();
        if (!reader) {
            setStatus("Could not reach the Celo network. Please check your connection.", "error");
            return Promise.resolve();
        }
        var farm = farmContract(reader);
        return farm.getFarm(WALLET).then(function (result) {
            return farm.rewardPool().then(function (pool) {
                farmState = {
                    principal: BigInt(result[0]),
                    chickens: BigInt(result[1]),
                    startedAt: Number(result[2]),
                    unlocksAt: Number(result[4]),
                    claimedProfit: BigInt(result[5]),
                    active: Boolean(result[6]),
                    mature: Boolean(result[7]),
                    eggs: BigInt(result[8]),
                    eggValue: BigInt(result[9]),
                    pool: BigInt(pool),
                };
                renderFarm();
                updateActionState();
                if (!farmState.active) {
                    setStatus("No active farm yet. Start one above to begin earning egg rewards.", "");
                } else if (farmState.pool < farmState.eggValue) {
                    var shortage = farmState.eggValue - farmState.pool;
                    setStatus("Active farm (" + HISTORY.formatWei(farmState.principal) + " G$). The reward pool is short by " +
                        HISTORY.formatWei(shortage) + " G$ — sell/close is disabled until an admin funds it.", "error");
                } else {
                    setStatus("Active farm: " + HISTORY.formatWei(farmState.principal) + " G$ principal, " +
                        farmState.chickens.toString() + " chickens. " +
                        (farmState.mature ? "Mature — ready to close." : "Still growing."), farmState.active ? "ok" : "");
                }
                return farmState;
            });
        }).catch(function (err) {
            setStatus("Could not load farm status. " + _errMessage(err), "error");
        });
    }

    // ── boot ────────────────────────────────────────────────────────────────

    function startTick() {
        if (tickTimer) clearInterval(tickTimer);
        tickTimer = setInterval(function () {
            if (farmState && farmState.active) renderFarm();
        }, 1000);
    }

    function init() {
        if (typeof ethers === "undefined") {
            setStatus("Wallet libraries are still loading. Please refresh the page.", "error");
            return;
        }
        if (typeof GMWalletConnect !== "undefined") {
            GMWalletConnect.configure({
                walletAddress: WALLET,
                loginMethod: LOGIN_METHOD,
                projectId: boot.walletconnectProjectId || "",
                dappName: "GoodMarket — Farming",
                dappDescription: "Farm chickens and earn G$ egg rewards on Celo",
                assetVersion: boot.assetVersion || "",
            });
        }

        var input = $("farmAmount");
        if (input) {
            input.addEventListener("input", updateChickensToBuy);
            if (!input.value) input.value = String(MIN_FARM);
        }
        document.querySelectorAll("[data-farm-amount]").forEach(function (button) {
            button.addEventListener("click", function () {
                if (!input) return;
                input.value = button.dataset.farmAmount;
                updateChickensToBuy();
            });
        });
        updateChickensToBuy();

        var startBtn = $("startFarmBtn");
        if (startBtn) startBtn.addEventListener("click", startFarm);
        var refreshBtn = $("refreshFarmBtn");
        if (refreshBtn) refreshBtn.addEventListener("click", function () {
            setStatus("Refreshing farm status…");
            return refreshFarm();
        });
        var sellBtn = $("sellEggsBtn");
        if (sellBtn) sellBtn.addEventListener("click", sellEggs);
        var closeBtn = $("closeFarmBtn");
        if (closeBtn) closeBtn.addEventListener("click", closeFarm);
        var refreshHistoryBtn = $("refreshHistoryBtn");
        if (refreshHistoryBtn) refreshHistoryBtn.addEventListener("click", function () {
            toast("Checking on-chain status of pending transactions…", "info");
            reconcilePending().then(function () {
                toast("Transaction history is up to date.", "success");
            });
        });
        var closeModalBtn = $("closeSuccessClose");
        if (closeModalBtn) closeModalBtn.addEventListener("click", closeCloseModal);

        renderHistory();
        startTick();
        reconcilePending().then(refreshFarm);
    }

    window.GMFarm = {
        init: init,
        refreshFarm: refreshFarm,
        renderHistory: renderHistory,
        validateFarmAmount: validateFarmAmount,
        projectedMonthlyProfit: projectedMonthlyProfit,
        describeCloseSuccess: describeCloseSuccess,
        describeSellSuccess: describeSellSuccess,
        sumGdReceived: sumGdReceived,
        settleFromReceipt: settleFromReceipt,
        reconcilePending: reconcilePending,
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
