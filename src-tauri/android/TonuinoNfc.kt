// TonUINO Studio: RFID cards with the phone's own NFC.
// scripts/build-android.sh copies this file next to the MainActivity that
// `tauri android init` generates and sets the package line to that package.

package app.tonuinostudio.desktop

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.nfc.tech.MifareClassic
import android.nfc.tech.MifareUltralight
import android.nfc.tech.NfcA
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

/**
 * The page in the WebView (src/platform/tauri/nfcAndroid.ts) reads and writes
 * TonUINO cards through this object, added as `window.TonuinoNfc`.
 *
 * The card logic is the one of the desktop's PC/SC reader (src-tauri/src/nfc.rs):
 * TonUINO keeps 16 bytes in MIFARE Classic block 4 (sector 1, key A
 * FF FF FF FF FF FF) or in MIFARE Ultralight / NTAG21x pages 8 to 11. Every
 * write is read back and compared.
 *
 * From the page (any thread, answers at once):
 *   state()          "none" (no NFC in this phone), "off" or "on"
 *   openSettings()   the system's NFC settings
 *   start(), stop()  reader mode on or off (kept across pause and resume)
 * From the page (answered later through window.__tonuinoNfc.done(id, result)):
 *   read(id)         {ok, uid, type, data: 32 hex digits}
 *   write(id, hex, uid) {ok, uid, type}; uid is the card the page read and means
 *                    ("" for whichever came last): another card there is refused
 *   check(id)        {ok, uid, type} while the last card is still at the phone
 * Errors: {ok: false, code, message, hints?}. Codes: no-nfc, nfc-off, no-card,
 * tag-lost, wrong-card, unsupported-card, classic-unsupported, auth-failed,
 * verify-failed, invalid-argument, other.
 * To the page: window.__tonuinoNfc.tag({uid, type, sak, atqa, classic}) when a card
 * comes to the phone, window.__tonuinoNfc.state(state) when the app comes back
 * to the front (NFC may have been switched on in the settings meanwhile) and
 * when NFC is switched on or off while the app is in the front.
 */
class TonuinoNfc(private val activity: Activity, private val webView: WebView) : NfcAdapter.ReaderCallback {
    companion object {
        /** The name of the object in the page. */
        const val NAME = "TonuinoNfc"
        private const val LOG_TAG = "TonuinoNfc"
        private const val CLASSIC_SECTOR = 1
        private const val CLASSIC_BLOCK = 4
        private const val UL_FIRST_PAGE = 8
        private val DEFAULT_KEY = ByteArray(6) { 0xFF.toByte() }
        /** Key A many phone apps set when they "format" a card for NDEF. */
        private val NDEF_KEY = byteArrayOf(0xD3.toByte(), 0xF7.toByte(), 0xD3.toByte(), 0xF7.toByte(), 0xD3.toByte(), 0xF7.toByte())
        /** How often Android checks that the card is still there, in ms. */
        private const val PRESENCE_CHECK_MS = 250
        private val ID_PATTERN = Regex("^[A-Za-z0-9_-]{1,64}$")
        private val HEX_PATTERN = Regex("^[0-9A-Fa-f]{32}$")
    }

    /** A failure with a code the page knows (see the list above). */
    private class CardError(val code: String, message: String, val hints: List<String> = emptyList()) : Exception(message)

    private val adapter: NfcAdapter? = NfcAdapter.getDefaultAdapter(activity)
    private val main = Handler(Looper.getMainLooper())
    /** One card operation at a time, never on the UI thread. */
    private val worker = Executors.newSingleThreadExecutor()

    /** The page wants reader mode (start() without stop()). Only touched on the UI thread. */
    private var wanted = false
    /** The activity is in the front. Only touched on the UI thread. */
    private var resumed = false
    /** Reader mode is on right now. Only touched on the UI thread. */
    private var reading = false

    /** The last card that came to the phone, and its type. */
    @Volatile private var lastTag: Tag? = null
    @Volatile private var lastType: String = "unknown"

    /**
     * NFC switched on or off in the quick settings, without leaving the app:
     * the page hears it, and reader mode starts again once NFC is on.
     */
    private val stateReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val s = intent.getIntExtra(NfcAdapter.EXTRA_ADAPTER_STATE, NfcAdapter.STATE_OFF)
            if (s != NfcAdapter.STATE_ON && s != NfcAdapter.STATE_OFF) return
            main.post {
                if (s == NfcAdapter.STATE_ON && wanted && resumed) {
                    // Reader mode asked for while NFC was off may not have taken hold.
                    reading = false
                    applyReaderMode()
                }
                pushState()
            }
        }
    }

    init {
        if (adapter != null) registerSystemReceiver(activity, stateReceiver, IntentFilter(NfcAdapter.ACTION_ADAPTER_STATE_CHANGED))
    }

    /* ------------------------------------------------------------ the page */

    @JavascriptInterface
    fun state(): String {
        val a = adapter ?: return "none"
        return if (a.isEnabled) "on" else "off"
    }

    @JavascriptInterface
    fun openSettings() {
        main.post {
            try {
                activity.startActivity(Intent(Settings.ACTION_NFC_SETTINGS))
            } catch (e: ActivityNotFoundException) {
                try {
                    activity.startActivity(Intent(Settings.ACTION_WIRELESS_SETTINGS))
                } catch (e2: ActivityNotFoundException) {
                    Log.w(LOG_TAG, "no settings page for NFC", e2)
                }
            }
        }
    }

    @JavascriptInterface
    fun start() {
        main.post {
            wanted = true
            applyReaderMode()
        }
    }

    @JavascriptInterface
    fun stop() {
        main.post {
            wanted = false
            applyReaderMode()
        }
    }

    @JavascriptInterface
    fun read(id: String) {
        if (!ID_PATTERN.matches(id)) return
        onWorker { answer(id) { readCard() } }
    }

    @JavascriptInterface
    fun write(id: String, hex: String, uid: String) {
        if (!ID_PATTERN.matches(id)) return
        onWorker {
            answer(id) {
                if (!HEX_PATTERN.matches(hex)) throw CardError("invalid-argument", "exactly 16 bytes (32 hex digits) expected")
                writeCard(fromHex(hex), uid)
            }
        }
    }

    @JavascriptInterface
    fun check(id: String) {
        if (!ID_PATTERN.matches(id)) return
        onWorker { answer(id) { checkCard() } }
    }

    /* ------------------------------------------------------ the activity */

    /** From MainActivity.onResume. */
    fun resume() {
        resumed = true
        applyReaderMode()
        // NFC may have been switched on in the settings meanwhile.
        pushState()
    }

    private fun pushState() {
        push("window.__tonuinoNfc && window.__tonuinoNfc.state && window.__tonuinoNfc.state(" + JSONObject.quote(state()) + ")")
    }

    /** From MainActivity.onPause: Android allows reader mode only while the app is in the front. */
    fun pause() {
        resumed = false
        applyReaderMode()
    }

    /** From MainActivity.onDestroy: no more answers to this page. */
    fun close() {
        wanted = false
        resumed = false
        applyReaderMode()
        worker.shutdownNow()
        if (adapter != null) {
            try {
                activity.unregisterReceiver(stateReceiver)
            } catch (e: IllegalArgumentException) {
                // Not registered.
            }
        }
    }

    /** UI thread only. */
    private fun applyReaderMode() {
        val a = adapter ?: return
        val on = wanted && resumed
        if (on == reading) return
        try {
            if (on) {
                val extras = Bundle()
                extras.putInt(NfcAdapter.EXTRA_READER_PRESENCE_CHECK_DELAY, PRESENCE_CHECK_MS)
                a.enableReaderMode(activity, this, NfcAdapter.FLAG_READER_NFC_A or NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK, extras)
            } else {
                a.disableReaderMode(activity)
            }
            reading = on
        } catch (e: RuntimeException) {
            // IllegalStateException when the activity is not in the front after all.
            Log.w(LOG_TAG, "reader mode", e)
        }
    }

    /* -------------------------------------------------------------- cards */

    /** A card came to the phone (a binder thread of the NFC service). */
    override fun onTagDiscovered(tag: Tag) {
        onWorker {
            val type = try {
                detectType(tag)
            } catch (e: Exception) {
                Log.w(LOG_TAG, "card type", e)
                "unknown"
            }
            lastTag = tag
            lastType = type
            val event = cardJson(tag, type)
            val nfcA = NfcA.get(tag)
            if (nfcA != null) {
                event.put("sak", hex(byteArrayOf(nfcA.sak.toByte()), ""))
                event.put("atqa", hex(nfcA.atqa, ""))
            }
            // MIFARE Classic needs a chip from NXP in the phone; Android then lists the technology.
            if (isClassic(type)) event.put("classic", MifareClassic.get(tag) != null)
            push("window.__tonuinoNfc && window.__tonuinoNfc.tag(" + event.toString() + ")")
        }
    }

    /** Like nfc.rs: SAK for MIFARE Classic, GET_VERSION for NTAG213/215/216. */
    private fun detectType(tag: Tag): String {
        val nfcA = NfcA.get(tag) ?: return "unknown"
        // The SAK values Android itself takes for MIFARE Classic (android.nfc.tech.MifareClassic).
        return when (nfcA.sak.toInt() and 0xFF) {
            0x01, 0x08, 0x10, 0x28, 0x88 -> "mifare-classic-1k"
            0x11, 0x18, 0x38, 0x98, 0xB8 -> "mifare-classic-4k"
            0x09 -> "mifare-classic-mini"
            0x00 -> ultralightType(nfcA)
            else -> "unknown"
        }
    }

    /** NTAG213/215/216 from GET_VERSION; an original Ultralight does not know it and stays "mifare-ultralight". */
    private fun ultralightType(nfcA: NfcA): String {
        return try {
            nfcA.connect()
            ntagFromVersion(nfcA.transceive(byteArrayOf(0x60))) ?: "mifare-ultralight"
        } catch (e: IOException) {
            "mifare-ultralight"
        } finally {
            // close() also wakes the card up again after a command it did not know.
            closeQuietly { nfcA.close() }
        }
    }

    private fun ntagFromVersion(v: ByteArray): String? {
        if (v.size < 8 || v[1] != 0x04.toByte()) return null
        val product = v[2].toInt() and 0xFF
        val size = v[6].toInt() and 0xFF
        return when {
            product == 0x04 && size == 0x0F -> "ntag213"
            product == 0x04 && size == 0x11 -> "ntag215"
            product == 0x04 && size == 0x13 -> "ntag216"
            product == 0x03 -> "mifare-ultralight"
            else -> null
        }
    }

    private fun isClassic(type: String) = type.startsWith("mifare-classic")

    private fun isUltralight(type: String) = type == "mifare-ultralight" || type.startsWith("ntag")

    private fun currentTag(): Tag = lastTag ?: throw CardError("no-card", "no card came to the phone yet")

    private fun readCard(): JSONObject {
        val tag = currentTag()
        val type = lastType
        val data = when {
            isClassic(type) -> classic(tag) { mc ->
                login(mc)
                mc.readBlock(CLASSIC_BLOCK)
            }
            isUltralight(type) -> ultralight(tag) { it.read16() }
            else -> throw CardError("unsupported-card", "card type $type")
        }
        if (data.size < 16) throw CardError("read-failed", "read ${data.size} bytes")
        return cardJson(tag, type).put("data", hex(data.copyOf(16), ""))
    }

    private fun writeCard(data: ByteArray, expected: String): JSONObject {
        val tag = currentTag()
        val type = lastType
        // A card that came after the page read the one it means (its "tag" event still on the way) is not written unasked.
        val there = hex(tag.id, ":")
        if (expected.isNotEmpty() && !there.equals(expected, ignoreCase = true)) throw CardError("wrong-card", "expected $expected, the phone has $there")
        when {
            isClassic(type) -> classic(tag) { mc ->
                login(mc)
                mc.writeBlock(CLASSIC_BLOCK, data)
                verify(data) { mc.readBlock(CLASSIC_BLOCK) }
            }
            isUltralight(type) -> ultralight(tag) { ul ->
                for (i in 0 until 4) ul.writePage(UL_FIRST_PAGE + i, data.copyOfRange(i * 4, i * 4 + 4))
                verify(data) { ul.read16() }
            }
            else -> throw CardError("unsupported-card", "card type $type")
        }
        return cardJson(tag, type)
    }

    /** Whether the last card is still at the phone: it answers when called. */
    private fun checkCard(): JSONObject {
        val tag = currentTag()
        val nfcA = NfcA.get(tag) ?: throw CardError("unsupported-card", "no NFC-A card")
        try {
            nfcA.connect()
        } finally {
            closeQuietly { nfcA.close() }
        }
        return cardJson(tag, lastType)
    }

    /** Reads back what was written; a difference or a failed read is "verify-failed", like nfc.rs. */
    private fun verify(data: ByteArray, readBack: () -> ByteArray) {
        val back = try {
            readBack()
        } catch (e: IOException) {
            throw CardError("verify-failed", "read back: ${e.message ?: e.javaClass.simpleName}")
        }
        if (!back.copyOf(16).contentEquals(data)) {
            throw CardError("verify-failed", "wrote ${hex(data, " ")} but read ${hex(back.copyOf(16), " ")}")
        }
    }

    /* ----------------------------------------------------- MIFARE Classic */

    private fun <T> classic(tag: Tag, block: (MifareClassic) -> T): T {
        // Without a chip from NXP in the phone Android cannot talk MIFARE Classic at all.
        val mc = MifareClassic.get(tag) ?: throw CardError("classic-unsupported", "this phone cannot talk MIFARE Classic")
        var authFailed: CardError? = null
        try {
            mc.connect()
            return block(mc)
        } catch (e: CardError) {
            if (e.code != "auth-failed") throw e
            authFailed = e
        } finally {
            closeQuietly { mc.close() }
        }
        throw explainAuthFailure(tag, authFailed!!)
    }

    /** Sector 1 with key A FF…FF, like the TonUINO firmware. */
    private fun login(mc: MifareClassic) {
        if (!mc.authenticateSectorWithKeyA(CLASSIC_SECTOR, DEFAULT_KEY)) {
            throw CardError("auth-failed", "key A FF FF FF FF FF FF rejected for sector 1")
        }
    }

    /** After a failed login: a card "formatted" by a phone app (NDEF key D3 F7 …) gets its own hint, like nfc.rs. */
    private fun explainAuthFailure(tag: Tag, err: CardError): CardError {
        val ndef = try {
            val mc = MifareClassic.get(tag)
            if (mc == null) {
                false
            } else {
                try {
                    mc.connect()
                    mc.authenticateSectorWithKeyA(CLASSIC_SECTOR, NDEF_KEY)
                } finally {
                    closeQuietly { mc.close() }
                }
            }
        } catch (e: Exception) {
            false
        }
        return CardError(err.code, err.message ?: "", listOf(if (ndef) "card-ndef-formatted" else "card-keys-changed"))
    }

    /* ------------------------------------------- MIFARE Ultralight / NTAG */

    /** Pages 8 to 11 through MifareUltralight, or plain NFC-A commands where Android does not offer it. */
    private interface Pages {
        fun read16(): ByteArray
        fun writePage(page: Int, data: ByteArray)
    }

    private fun <T> ultralight(tag: Tag, block: (Pages) -> T): T {
        val ul = MifareUltralight.get(tag)
        if (ul != null) {
            try {
                ul.connect()
                return block(object : Pages {
                    override fun read16(): ByteArray = ul.readPages(UL_FIRST_PAGE)
                    override fun writePage(page: Int, data: ByteArray) = ul.writePage(page, data)
                })
            } finally {
                closeQuietly { ul.close() }
            }
        }
        val nfcA = NfcA.get(tag) ?: throw CardError("unsupported-card", "no NFC-A card")
        try {
            nfcA.connect()
            return block(object : Pages {
                // READ (0x30) answers 16 bytes: four pages.
                override fun read16(): ByteArray = nfcA.transceive(byteArrayOf(0x30, UL_FIRST_PAGE.toByte()))
                // WRITE (0xA2) of one page of 4 bytes.
                override fun writePage(page: Int, data: ByteArray) {
                    nfcA.transceive(byteArrayOf(0xA2.toByte(), page.toByte()) + data)
                }
            })
        } finally {
            closeQuietly { nfcA.close() }
        }
    }

    /* ------------------------------------------------------------ answers */

    /** Runs one operation on the worker thread and hands its result to the page. */
    private fun answer(id: String, op: () -> JSONObject) {
        val result = try {
            op().put("ok", true)
        } catch (e: CardError) {
            failure(e.code, e.message, e.hints)
        } catch (e: IOException) {
            // TagLostException and every other failed exchange: the card left the phone, or never answered properly.
            failure("tag-lost", e.message ?: e.javaClass.simpleName, emptyList())
        } catch (e: SecurityException) {
            // "Tag is out of date": another card came to the phone meanwhile.
            failure("tag-lost", e.message ?: e.javaClass.simpleName, emptyList())
        } catch (e: Exception) {
            Log.w(LOG_TAG, "card operation", e)
            failure("other", e.message ?: e.javaClass.simpleName, emptyList())
        }
        push("window.__tonuinoNfc && window.__tonuinoNfc.done(" + JSONObject.quote(id) + "," + result.toString() + ")")
    }

    private fun failure(code: String, message: String?, hints: List<String>): JSONObject {
        val o = JSONObject().put("ok", false).put("code", code).put("message", message ?: code)
        if (hints.isNotEmpty()) o.put("hints", JSONArray(hints))
        return o
    }

    private fun cardJson(tag: Tag, type: String): JSONObject = JSONObject().put("uid", hex(tag.id, ":")).put("type", type)

    /** Queues a card operation; nothing happens once the activity is gone. */
    private fun onWorker(task: () -> Unit) {
        try {
            worker.execute(task)
        } catch (e: RejectedExecutionException) {
            // close() was called.
        }
    }

    /** evaluateJavascript only works on the UI thread. */
    private fun push(script: String) {
        main.post { webView.evaluateJavascript(script, null) }
    }

    private inline fun closeQuietly(close: () -> Unit) {
        try {
            close()
        } catch (e: IOException) {
            // Already gone.
        }
    }

    /** Upper-case hex like nfc.rs (hex_upper), the same in every language setting of the phone. */
    private fun hex(bytes: ByteArray, sep: String): String =
        bytes.joinToString(sep) { b -> "0123456789ABCDEF"[(b.toInt() shr 4) and 0x0F].toString() + "0123456789ABCDEF"[b.toInt() and 0x0F] }

    private fun fromHex(s: String): ByteArray = ByteArray(s.length / 2) { i -> s.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
}
