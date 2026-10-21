// TonUINO Studio: how the Kotlin bridges answer the page.
// scripts/build-android.sh copies this file next to the MainActivity that
// `tauri android init` generates and sets the package line to that package.

package app.tonuinostudio.desktop

import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import org.json.JSONObject
import java.io.FileNotFoundException
import java.io.IOException

/**
 * The page side of TonuinoFiles and TonuinoUsb (src/platform/tauri/androidBridge.ts):
 *
 *   window.__tonuinoAndroid.done(id, result)   result = {ok: true, …} or {ok: false, code, message}
 *   window.__tonuinoAndroid.event(name, data)
 *
 * A big answer is kept here as a payload and fetched by the page through the
 * bridge's take(id) right when done() arrives, so it never has to be parsed
 * as script.
 */
class TonuinoPage(private val webView: WebView) {
    private val main = Handler(Looper.getMainLooper())

    /** Payloads waiting for take(); a page that reloaded meanwhile never takes them, so only a few are kept. */
    private val payloads = object : LinkedHashMap<String, String>() {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?): Boolean = size > MAX_PAYLOADS
    }

    companion object {
        private const val MAX_PAYLOADS = 16
        private val ID_PATTERN = Regex("^[A-Za-z0-9_-]{1,64}$")

        fun validId(id: String): Boolean = ID_PATTERN.matches(id)

        /**
         * A code the page knows for a failure of Android's file or USB calls.
         * The messages are the system's (English); the page has its own words.
         */
        fun codeOf(e: Throwable): String {
            val text = (e.message ?: "") + " " + (e.cause?.message ?: "")
            return when {
                text.contains("ENOSPC") || text.contains("No space left") -> "full"
                text.contains("EROFS") || text.contains("Read-only file system") -> "read-only"
                e is SecurityException || text.contains("EACCES") || text.contains("Permission denied") -> "denied"
                e is FileNotFoundException || text.contains("Missing file") || text.contains("FileNotFoundException") || text.contains("ENOENT") -> "not-found"
                e is UnsupportedOperationException -> "unsupported"
                e is IllegalStateException && text.contains("exists", ignoreCase = true) -> "exists"
                e is IOException -> "io"
                else -> "other"
            }
        }
    }

    /** An error with a code the page knows. */
    class Failure(val code: String, message: String) : Exception(message)

    fun done(id: String, result: JSONObject) {
        result.put("ok", true)
        run("window.__tonuinoAndroid && window.__tonuinoAndroid.done(" + JSONObject.quote(id) + "," + result.toString() + ")")
    }

    fun fail(id: String, code: String, message: String?) {
        val result = JSONObject().put("ok", false).put("code", code).put("message", message ?: code)
        run("window.__tonuinoAndroid && window.__tonuinoAndroid.done(" + JSONObject.quote(id) + "," + result.toString() + ")")
    }

    /** Answers with the result of `op`, or with the code of what it threw. */
    fun answer(id: String, op: () -> JSONObject) {
        try {
            done(id, op())
        } catch (e: Failure) {
            fail(id, e.code, e.message)
        } catch (e: Exception) {
            fail(id, codeOf(e), e.message ?: e.javaClass.simpleName)
        }
    }

    fun event(name: String, data: JSONObject) {
        run("window.__tonuinoAndroid && window.__tonuinoAndroid.event(" + JSONObject.quote(name) + "," + data.toString() + ")")
    }

    /** Keeps `text` for take(id); the result tells the page to fetch it. */
    fun payload(id: String, text: String): JSONObject {
        synchronized(payloads) { payloads[id] = text }
        return JSONObject().put("payload", true)
    }

    fun take(id: String): String = synchronized(payloads) { payloads.remove(id) } ?: ""

    fun onMain(task: () -> Unit) {
        main.post(task)
    }

    /** evaluateJavascript only works on the UI thread. */
    private fun run(script: String) {
        main.post { webView.evaluateJavascript(script, null) }
    }
}
