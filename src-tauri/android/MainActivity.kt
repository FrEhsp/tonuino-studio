// TonUINO Studio: the Android app's activity. scripts/build-android.sh puts
// this file in place of the MainActivity that `tauri android init` generates
// and sets the package line to that package (TauriActivity lives there too).

package app.tonuinostudio.desktop

import android.view.View
import android.webkit.WebView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
    private var nfc: TonuinoNfc? = null
    private var files: TonuinoFiles? = null
    private var usb: TonuinoUsb? = null
    private var inFront = false

    /**
     * Called by WryActivity on the UI thread once the app's WebView exists,
     * before it loads the page and before it becomes the content view.
     */
    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        val bridge = TonuinoNfc(this, webView)
        nfc = bridge
        // window.TonuinoNfc in the page (src/platform/tauri/nfcAndroid.ts).
        webView.addJavascriptInterface(bridge, TonuinoNfc.NAME)
        // window.TonuinoFiles and window.TonuinoUsb (src/platform/tauri/android.ts), answering through one page helper.
        val page = TonuinoPage(webView)
        val fileBridge = TonuinoFiles(this, page)
        files = fileBridge
        webView.addJavascriptInterface(fileBridge, TonuinoFiles.NAME)
        val usbBridge = TonuinoUsb(this, page)
        usb = usbBridge
        webView.addJavascriptInterface(usbBridge, TonuinoUsb.NAME)
        if (inFront) bridge.resume()
        // Runs once the WebView sits in the content view.
        webView.post { (webView.parent as? View)?.let { keepClearOfSystemBars(it) } }
    }

    override fun onResume() {
        super.onResume()
        inFront = true
        nfc?.resume()
    }

    override fun onPause() {
        inFront = false
        nfc?.pause()
        super.onPause()
    }

    override fun onDestroy() {
        nfc?.close()
        nfc = null
        files?.close()
        files = null
        usb?.closeAll()
        usb = null
        super.onDestroy()
    }

    /**
     * Newer Android versions draw the app under the status bar, the navigation
     * bar and the keyboard. The page stays inside them instead.
     */
    private fun keepClearOfSystemBars(content: View) {
        ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
            WindowInsetsCompat.CONSUMED
        }
        ViewCompat.requestApplyInsets(content)
    }
}
