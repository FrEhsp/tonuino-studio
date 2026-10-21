# TonUINO Studio: the page calls these methods by name (window.TonuinoNfc,
# window.TonuinoFiles, window.TonuinoUsb).
# scripts/build-android.sh appends this to the generated proguard-rules.pro
# with {{package}} set to the app's package.
-keep class {{package}}.TonuinoNfc {
  @android.webkit.JavascriptInterface public <methods>;
}
-keep class {{package}}.TonuinoFiles {
  @android.webkit.JavascriptInterface public <methods>;
}
-keep class {{package}}.TonuinoUsb {
  @android.webkit.JavascriptInterface public <methods>;
}
