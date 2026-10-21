fn main() {
  // The Linux app answers GDK's screen-size questions itself (src/screenrate.rs);
  // WebKit only finds those functions if the executable exports them.
  if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
    for name in ["gdk_monitor_get_width_mm", "gdk_monitor_get_height_mm"] {
      println!("cargo:rustc-link-arg-bins=-Wl,--export-dynamic-symbol={name}");
    }
  }
  tauri_build::build()
}
