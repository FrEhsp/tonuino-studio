/** Build setting of the bench builds (scripts/bench/shots.mjs). */
interface ImportMetaEnv {
  /** "1": "?als=handy" in the address shows the web app as the Android app (src/app/asPhone.ts). Never set for a release. */
  readonly VITE_BENCH_HANDY?: string;
}
