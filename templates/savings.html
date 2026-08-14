/* GoodMarket transaction-error formatter
 *
 * Frontend pages call ethers.js / WalletConnect / MiniPay through a wide
 * variety of paths, and each of them surfaces failures with a different
 * shape. ethers v6 in particular wraps EIP-1193 errors as
 *   "could not coalesce error (error={…},payload={…},code=UNKNOWN_ERROR,…)"
 * which is fine for debugging but is hostile UX when shown directly to a
 * non-developer.
 *
 * `GMTxError.format(err)` walks the (possibly nested) error and returns a
 * short, human-readable message that's safe to drop into an alert string
 * with no JSON / dev-only fields leaking through.
 *
 * The detector covers:
 *   - User cancellations (EIP-1193 4001, WalletConnect 5000/5001/-32603,
 *     "user rejected", "user denied", "user disapproved", "request rejected",
 *     etc.)
 *   - Insufficient balance / funds
 *   - Gas estimation / out-of-gas
 *   - Network / RPC connectivity
 *   - Approval-required hints
 *   - Generic fallback that strips ethers.js boilerplate
 *
 * No external dependencies — load before any caller via
 *   <script src="/static/js/tx-error.js?v={{ ASSET_VERSION }}"></script>
 */
(function (global) {
    "use strict";

    if (global.GMTxError && typeof global.GMTxError.format === "function") return;

    // Wrap a thrown Error so format() will pass `.message` through verbatim
    // (instead of running it through the wallet/RPC pattern detector and
    // replacing it with a generic "Insufficient funds for gas" string).
    // Use this for preflight errors where the caller already produced a
    // user-facing message.
    function asFriendly(err) {
        if (err && typeof err === "object") {
            try { err._gmFriendly = true; } catch (_) {}
        }
        return err;
    }

    function _stringify(value) {
        if (value == null) return "";
        if (typeof value === "string") return value;
        try { return JSON.stringify(value); } catch (_) {}
        try { return String(value); } catch (_) {}
        return "";
    }

    // Walk up to a few levels deep, collecting every plausible message /
    // code / data field. Some errors stack `cause` / `info` / `error`
    // several layers deep (MetaMask → ethers.js → BrowserProvider).
    function _spelunk(err) {
        var out = { code: undefined, msg: "", joined: "" };
        if (!err) return out;
        var seen = new Set();
        var stack = [err];
        var pieces = [];
        while (stack.length) {
            var cur = stack.shift();
            if (!cur || typeof cur !== "object" || seen.has(cur)) continue;
            seen.add(cur);
            if (out.code === undefined && cur.code !== undefined) out.code = cur.code;
            if (typeof cur.shortMessage === "string") pieces.push(cur.shortMessage);
            if (typeof cur.reason === "string") pieces.push(cur.reason);
            if (typeof cur.message === "string") pieces.push(cur.message);
            if (typeof cur.data === "string") pieces.push(cur.data);
            if (cur.error) stack.push(cur.error);
            if (cur.cause) stack.push(cur.cause);
            if (cur.info) stack.push(cur.info);
            if (cur.data && typeof cur.data === "object") stack.push(cur.data);
            if (cur.payload && typeof cur.payload === "object") stack.push(cur.payload);
        }
        out.msg = pieces.length ? pieces[0] : "";
        out.joined = pieces.join(" \n ");
        return out;
    }

    function _isUserRejection(code, joined) {
        if (code === 4001 || code === 4100 || code === 4200) return true; // EIP-1193
        if (code === 5000 || code === 5001 || code === 5002) return true; // WalletConnect "user disapproved"
        if (code === "ACTION_REJECTED") return true; // ethers v6 explicit code
        var rx = /user rejected|user denied|user disapproved|user cancel|request[ _]?rejected|rejected by user|action_rejected|user closed|user dismissed|reject(ed)? the request|you rejected|signature was rejected|approval rejected|transaction rejected|denied transaction signature/i;
        return rx.test(joined);
    }

    function _isInsufficientFunds(joined) {
        return /insufficient funds|insufficient balance|exceeds balance|not enough .*(funds|balance|gas)/i.test(joined);
    }

    function _isGasIssue(joined) {
        return /out of gas|intrinsic gas too low|gas required exceeds|exceeds block gas limit/i.test(joined);
    }

    function _isAllowanceIssue(joined) {
        return /erc20: insufficient allowance|allowance|stf|transferhelper|transfer_from_failed|safetransferfrom/i.test(joined);
    }

    function _isReverted(joined) {
        // "missing revert data in call exception" is ethers v6's opaque
        // wrapper for an eth_call/eth_estimateGas that reverted with no
        // recoverable `data` blob. It IS a revert from the user's POV —
        // treat it as one so we show actionable copy instead of a cryptic
        // technical string.
        return /execution reverted|call exception|transaction reverted|missing revert data|missing revert|eth_call revert|intrinsic gas too low/i.test(joined);
    }

    // Decode a 0x-prefixed revert `data` blob into a human string.
    // Handles:
    //   - Error(string)  selector 0x08c379a0
    //   - Panic(uint256) selector 0x4e487b71
    //   - Custom errors (returns the 4-byte selector when undecodable)
    // Returns "" when the input is not a recognisable revert payload.
    function _decodeRevertData(hex) {
        if (typeof hex !== "string") return "";
        var h = hex.toLowerCase();
        if (h === "0x" || h === "" ) return "";
        if (h.indexOf("0x") === 0) h = h.slice(2);
        if (h.length < 8) return "";
        var sel = h.slice(0, 8);
        function _hexToUtf8(seg) {
            var bytes = [];
            for (var i = 0; i < seg.length; i += 2) bytes.push(parseInt(seg.substr(i, 2), 16));
            try { return decodeURIComponent(escape(String.fromCharCode.apply(null, bytes))); } catch (_) { return ""; }
        }
        if (sel === "08c379a0") {
            // Error(string) ABI layout (after stripping 0x):
            //   [0..8)    selector
            //   [8..72)   offset (0x20)
            //   [72..136) uint256 string length
            //   [136..)   string bytes, left-padded to 32
            if (h.length < 136) return "execution reverted";
            var lenHex = h.slice(72, 136);
            var len = parseInt(lenHex, 16);
            if (!isFinite(len) || len <= 0) return "execution reverted";
            var strHex = h.slice(136, 136 + len * 2);
            var msg = _hexToUtf8(strHex);
            return msg ? ("execution reverted: " + msg) : "execution reverted";
        }
        if (sel === "4e487b71") {
            // Panic(uint256): code in the last 32-byte word
            var panicCode = h.length >= 72 ? parseInt(h.slice(h.length - 64), 16) : 0;
            var known = {
                0x01: "assertion failed",
                0x11: "arithmetic overflow/underflow",
                0x12: "division or modulo by zero",
                0x21: "enum conversion out of bounds",
                0x22: "incorrect array storage encoding",
                0x31: "pop on empty array",
                0x32: "array access out of bounds",
                0x41: "out of memory",
                0x51: "uninitialized function pointer"
            };
            var label = known[panicCode] || ("panic code 0x" + (panicCode || 0).toString(16));
            return "panic: " + label;
        }
        // Custom error — surface the selector so support can look it up.
        return "execution reverted (selector 0x" + sel + ")";
    }

    function _revertReasonFromError(err) {
        var info = _spelunk(err);
        // Prefer an explicit .data revert blob carried on the error.
        var pieces = [err && err.data, info && info.joined];
        for (var i = 0; i < pieces.length; i++) {
            var decoded = _decodeRevertData(pieces[i]);
            if (decoded) return decoded;
        }
        return "";
    }

    function _isNetworkIssue(joined) {
        return /failed to fetch|network error|networkerror|timeout|timed out|fetch failed|err_network|err_internet|connection refused|aborted/i.test(joined);
    }

    function _isWcSessionIssue(joined) {
        return /walletconnect.*(unavailable|not active|approval timed out|expired|not configured)|wc session|session not (found|established)/i.test(joined);
    }

    function _isUnsupportedRpcMethod(joined) {
        // Mobile wallets that can't service ethers' read-only preflight RPCs
        // typically reply with "Missing or invalid. request() method: …"
        // (Trust, MiniPay, etc.). Surface a non-technical retry hint.
        return /missing or invalid\.? request\(\) method|method not supported|method not found|unsupported method/i.test(joined);
    }

    function _isQuoteIssue(joined) {
        return /allowance too low.*approval|approval may not have been confirmed/i.test(joined);
    }

    function _stripEthersBoilerplate(s) {
        if (!s) return "";
        return String(s)
            .replace(/\(error=\{[\s\S]*?\}(,|\))/g, "")
            .replace(/\(payload=\{[\s\S]*?\}(,|\))/g, "")
            .replace(/\(action="[^"]+",?/g, "")
            .replace(/\(transaction=\{[\s\S]*?\}(,|\))/g, "")
            .replace(/\(reason=null,?/g, "")
            .replace(/\bcode=[A-Z_]+,?/g, "")
            .replace(/\bversion=[\d.]+\)?/g, "")
            .replace(/[\(\),]+\s*$/g, "")
            .replace(/\s{2,}/g, " ")
            .replace(/^\s*[:\-]\s*/, "")
            .trim();
    }

    function _capitalize(s) {
        if (!s) return s;
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    function _truncate(s, n) {
        n = n || 180;
        if (!s) return s;
        return s.length > n ? s.slice(0, n - 1).trim() + "…" : s;
    }

    function format(err) {
        if (err == null) return "Unknown error";
        if (typeof err === "string") return _truncate(_stripEthersBoilerplate(err)) || "Unknown error";

        // Preflight errors raised by app code with `_gmFriendly = true`
        // already contain a user-facing, fully-itemized message — pass them
        // through verbatim instead of crushing them into a generic
        // "Insufficient CELO for gas fees" string.
        if (err && err._gmFriendly === true && typeof err.message === "string" && err.message) {
            return _truncate(err.message, 280);
        }

        var info = _spelunk(err);
        var msg = info.msg || "";
        var joined = info.joined || "";
        var code = info.code;

        if (_isUserRejection(code, joined)) return "Transaction cancelled in your wallet.";
        if (_isUnsupportedRpcMethod(joined)) return "Your wallet couldn't process this request. Please retry, or reconnect WalletConnect from the homepage.";
        if (_isWcSessionIssue(joined)) {
            if (/timed out|expired/i.test(joined)) return "WalletConnect approval timed out. Please try again.";
            if (/not configured/i.test(joined)) return "WalletConnect is not configured on this server.";
            return "WalletConnect session is not active. Please reconnect and try again.";
        }
        if (_isInsufficientFunds(joined)) {
            if (/celo|gas/i.test(joined)) return "Insufficient CELO for gas fees. Please top up CELO and try again.";
            return "Insufficient balance for this transaction.";
        }
        if (_isAllowanceIssue(joined)) return "Token approval is missing or too low. Please re-approve and try again.";
        if (_isGasIssue(joined)) return "Transaction needs more gas. Please try again or contact support.";
        if (_isNetworkIssue(joined)) return "Network error. Please check your connection and try again.";
        if (_isReverted(joined)) {
            // Try to recover a concrete revert reason. When the wallet/RPC
            // omitted the `data` blob (the "missing revert data" case) we
            // can't decode anything, so guide the user toward the most
            // common real causes (allowance, slippage, balance) instead of
            // dumping the raw ethers string.
            var reason = _revertReasonFromError(err);
            if (reason && reason.indexOf("selector") === -1 && reason.indexOf("execution reverted: ") === 0) {
                return "Transaction was rejected on-chain: " + reason.replace("execution reverted: ", "") + ". Check the inputs and try again.";
            }
            if (_isAllowanceIssue(joined)) return "Token approval is missing or too low. Please re-approve and try again.";
            return "Transaction was rejected on-chain. Please check the amount, approve the token if needed, and try again.";
        }

        // Generic ethers wrapper — try to recover the inner message
        if (/could not coalesce error/i.test(msg)) {
            var inner = "";
            // Pluck the first useful inner message we already collected.
            var parts = (joined || "").split(" \n ");
            for (var i = 0; i < parts.length; i++) {
                var p = parts[i];
                if (!p || /could not coalesce error/i.test(p)) continue;
                inner = p; break;
            }
            if (inner) return _truncate(_stripEthersBoilerplate(inner)) || "Transaction failed. Please try again.";
            return "Transaction failed. Please try again.";
        }

        var clean = _stripEthersBoilerplate(msg);
        if (!clean) return "Transaction failed. Please try again.";
        return _truncate(_capitalize(clean));
    }

    function isUserRejection(err) {
        if (err == null) return false;
        var info = _spelunk(err);
        return _isUserRejection(info.code, info.joined || "");
    }

    // Gas-specific failure detection, exposed so savings.html / swap.html can
    // surface a gas-related message BEFORE their revert/allowance/balance
    // diagnostics. Otherwise a gas failure looks like an opaque revert and the
    // user gets told to "check the amount and token approval" when they really
    // just need CELO for gas. Covers:
    //  - insufficient funds for gas (wallet/estimateGas)
    //  - out of gas / intrinsic gas too low / exceeds block gas limit
    //  - app-level flag set by raw-tx helpers when eth_estimateGas itself failed
    function isInsufficientFunds(err) {
        if (err == null) return false;
        var joined = String(err.message || err.shortMessage || err.reason || "");
        return _isInsufficientFunds(joined);
    }

    function isGasIssue(err) {
        if (err == null) return false;
        if (err && err._gmGasEstimateFailed === true) return true;
        var joined = String(err.message || err.shortMessage || err.reason || "");
        return _isGasIssue(joined);
    }

    function isGasRelated(err) {
        if (err == null) return false;
        var joined = String(err.message || err.shortMessage || err.reason || "");
        if (_isGasIssue(joined)) return true;
        if (_isInsufficientFunds(joined) && /gas|fee|celo/i.test(joined)) return true;
        if (err && err._gmGasEstimateFailed === true) return true;
        return false;
    }

    // Run a read-only eth_call against a Celo RPC endpoint to recover the real
    // revert reason for a transaction that the wallet/RPC reported as
    // "missing revert data". Returns a decoded reason string, or "" when the
    // call doesn't revert or the reason can't be decoded. `to`/`data`/`from`/
    // `value` come from the failing tx params; multiple RPC URLs are tried so a
    // node that omits the `data` blob on reverts doesn't block decoding.
    function _simulateCallCelo(params) {
        var to = params && params.to;
        var data = (params && params.data) || "0x";
        var from = (params && params.from) || "0x0000000000000000000000000000000000000000";
        var value = (params && params.value) || "0x0";
        if (!to) return Promise.resolve("");
        var urls = [
            "https://forno.celo.org",
            "https://rpc.ankr.com/celo",
            "https://celo-rpc.publicnode.com"
        ];
        function tryUrl(i) {
            if (i >= urls.length) return Promise.resolve("");
            return fetch(urls[i], {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    jsonrpc: "2.0", id: Date.now(),
                    method: "eth_call",
                    params: [{ to: to, data: data, from: from, value: value }, "latest"]
                })
            }).then(function (r) { return r.json(); }).then(function (body) {
                if (body && body.error) {
                    var d = (body.error.data != null) ? body.error.data
                          : (typeof body.error.message === "string" ? body.error.message : "");
                    var decoded = _decodeRevertData(d);
                    if (decoded) return decoded;
                    // No data blob from this node → try the next RPC URL.
                    return tryUrl(i + 1);
                }
                if (body && typeof body.result === "string") {
                    // Call succeeded in simulation → the real tx should not
                    // revert for static reasons. (May still fail at submit due
                    // to gas/nonce.) No revert reason to report.
                    return "";
                }
                return tryUrl(i + 1);
            }).catch(function () { return tryUrl(i + 1); });
        }
        return tryUrl(0);
    }

    global.GMTxError = {
        format: format,
        isUserRejection: isUserRejection,
        asFriendly: asFriendly,
        // Exposed so swap.html / wallet.html can decode revert bytes directly
        // and run a fallback simulation when ethers reports "missing revert data".
        decodeRevertData: _decodeRevertData,
        revertReasonFromError: _revertReasonFromError,
        simulateCallCelo: _simulateCallCelo,
        isInsufficientFunds: isInsufficientFunds,
        isGasIssue: isGasIssue,
        isGasRelated: isGasRelated
    };
})(typeof window !== "undefined" ? window : globalThis);
