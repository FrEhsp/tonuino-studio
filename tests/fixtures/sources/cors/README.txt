CORS header snapshots as redirect chains (design session, key: entwurf, 2026-10-05), written by ../../proto/make-cors-fixtures.mjs.
kind "observed": headers as printed by the cited check (tester transcription or local curl), trimmed to the CORS-relevant ones.
kind "partial":  only the host root was observed; a file-level check is still missing (expect "unverified").
kind "synthetic": constructed chains for the browser rules that were verified with real Chromium against local servers
                 (../../cors/browser/README.txt). "<echo>" = the server answers with the Origin it received.
"expect" is what the builder's delivery check must conclude: "direct" (the app may fetch() it), "browser" (open the page, save,
drag in), "unverified" (treat as browser until a file-level check passes), "unstable" (treat as browser), "rejected" (host not allowed).
Rules under test: every hop needs Access-Control-Allow-Origin "*" or the exact Origin sent; after a redirect to another origin the
browser sends "Origin: null"; credentials are never sent, so "*" is enough. Check each chain for the web origin AND for the desktop
WebView origins tauri://localhost (Linux) and http://tauri.localhost (Windows).
