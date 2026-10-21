// TonUINO Studio: the SD card (any folder the user grants), saving and printing.
// scripts/build-android.sh copies this file next to the MainActivity that
// `tauri android init` generates and sets the package line to that package.

package app.tonuinostudio.desktop

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.Environment
import android.os.ParcelFileDescriptor
import android.os.StatFs
import android.print.PageRange
import android.print.PrintAttributes
import android.print.PrintDocumentAdapter
import android.print.PrintDocumentInfo
import android.print.PrintManager
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.Settings
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.SyncFailedException
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicInteger

/**
 * The page (src/platform/tauri/androidSaf.ts) reaches the SD card through
 * this object, added as `window.TonuinoFiles`. The card is a folder the user
 * granted in Android's own folder chooser (Storage Access Framework), mostly
 * the card in a USB card reader at the phone. Android keeps that grant
 * across restarts; the same card comes back when it is plugged in again.
 *
 * Documents are named by the tree URI of the granted folder and a document
 * id. Every call that touches the card runs on one worker thread, in the
 * order the page sent them, and answers through TonuinoPage.done().
 * Payloads (file bytes, folder lists) are fetched with take(id).
 *
 * Errors carry the codes of TonuinoPage.codeOf: not-found, denied, full,
 * read-only, exists, unsupported, io, other; and cancelled for a chooser
 * the user closed.
 */
class TonuinoFiles(private val activity: WryActivity, private val page: TonuinoPage) {
    companion object {
        /** The name of the object in the page. */
        const val NAME = "TonuinoFiles"
        private const val LOG_TAG = "TonuinoFiles"
        private const val PREFS = "tonuino-trees"
        /** Largest read in one call; the page asks in smaller parts. */
        private const val MAX_READ = 16 * 1024 * 1024
        private const val TEMP_PREFIX = "tonuino-"
        private val COLUMNS = arrayOf(
            Document.COLUMN_DOCUMENT_ID,
            Document.COLUMN_DISPLAY_NAME,
            Document.COLUMN_MIME_TYPE,
            Document.COLUMN_SIZE,
            Document.COLUMN_LAST_MODIFIED,
            Document.COLUMN_FLAGS,
        )
    }

    private val resolver: ContentResolver = activity.contentResolver
    /** One card operation at a time, never on the UI thread. */
    private val worker = Executors.newSingleThreadExecutor()
    private val writes = ConcurrentHashMap<String, Writer>()
    private val tokens = AtomicInteger()

    /** A file open for writing: on the card, or a temp file of the app (saveAs, print). */
    private class Writer(val pfd: ParcelFileDescriptor?, val out: FileOutputStream, val temp: File?)

    /** Android tells when a drive is mounted or removed: the page looks for its cards at once. */
    private val mediaReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            page.event("storage", JSONObject().put("action", intent.action ?: ""))
        }
    }

    init {
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_MEDIA_MOUNTED)
            addAction(Intent.ACTION_MEDIA_UNMOUNTED)
            addAction(Intent.ACTION_MEDIA_REMOVED)
            addAction(Intent.ACTION_MEDIA_BAD_REMOVAL)
            addAction(Intent.ACTION_MEDIA_EJECT)
            addDataScheme("file")
        }
        registerSystemReceiver(activity, mediaReceiver, filter)
        // What an earlier run left behind (a print the app never finished).
        activity.cacheDir.listFiles()?.filter { it.name.startsWith(TEMP_PREFIX) }?.forEach { it.delete() }
    }

    /* ------------------------------------------------------------ granted folders */

    @JavascriptInterface
    fun trees(): String {
        val out = JSONArray()
        val prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        for (p in resolver.persistedUriPermissions) {
            if (!p.isReadPermission || !p.isWritePermission) continue
            val uri = p.uri
            if (!DocumentsContract.isTreeUri(uri)) continue
            val doc = DocumentsContract.getTreeDocumentId(uri)
            val name = prefs.getString(uri.toString(), null) ?: fallbackName(doc)
            out.put(JSONObject().put("uri", uri.toString()).put("doc", doc).put("name", name))
        }
        return out.toString()
    }

    @JavascriptInterface
    fun release(uri: String) {
        try {
            resolver.releasePersistableUriPermission(Uri.parse(uri), Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        } catch (e: SecurityException) {
            // Not granted (any more).
        }
        activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(uri).apply()
    }

    @JavascriptInterface
    fun pickTree(id: String, persist: Boolean) {
        if (!TonuinoPage.validId(id)) return
        page.onMain {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION,
            )
            try {
                activity.launchActivityForResult(intent) { result ->
                    val uri = result?.data?.data
                    if (result?.resultCode != Activity.RESULT_OK || uri == null) {
                        page.fail(id, "cancelled", "no folder chosen")
                    } else {
                        onWorker(id) { picked(uri, persist) }
                    }
                }
            } catch (e: Exception) {
                page.fail(id, "unsupported", e.message ?: "no folder chooser")
            }
        }
    }

    private fun picked(uri: Uri, persist: Boolean): JSONObject {
        if (persist) resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        val doc = DocumentsContract.getTreeDocumentId(uri)
        val name = try {
            entry(uri, doc).optString("name").ifEmpty { fallbackName(doc) }
        } catch (e: Exception) {
            fallbackName(doc)
        }
        if (persist) activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(uri.toString(), name).apply()
        return JSONObject().put("uri", uri.toString()).put("doc", doc).put("name", name)
    }

    /** "1234-ABCD:Musik" → "Musik", "1234-ABCD:" → "1234-ABCD". */
    private fun fallbackName(doc: String): String {
        val path = doc.substringAfter(':', "")
        return if (path.isNotEmpty()) path.substringAfterLast('/') else doc.substringBefore(':').ifEmpty { "SD-Karte" }
    }

    /* ------------------------------------------------------------ documents */

    private fun docUri(tree: String, doc: String): Uri = DocumentsContract.buildDocumentUriUsingTree(Uri.parse(tree), doc)

    private fun row(c: Cursor): JSONObject {
        val o = JSONObject()
            .put("id", c.getString(0))
            .put("name", c.getString(1) ?: "")
            .put("mime", c.getString(2) ?: "application/octet-stream")
        if (!c.isNull(3)) o.put("size", c.getLong(3))
        if (!c.isNull(4)) o.put("modified", c.getLong(4))
        if (!c.isNull(5)) o.put("flags", c.getInt(5))
        return o
    }

    private fun entry(treeUri: Uri, doc: String): JSONObject {
        val uri = DocumentsContract.buildDocumentUriUsingTree(treeUri, doc)
        val c = resolver.query(uri, COLUMNS, null, null, null) ?: throw TonuinoPage.Failure("not-found", "no answer for $doc")
        c.use {
            if (!it.moveToFirst()) throw TonuinoPage.Failure("not-found", "no document $doc")
            return row(it)
        }
    }

    private fun entryOf(uri: Uri): JSONObject {
        val c = resolver.query(uri, COLUMNS, null, null, null) ?: throw TonuinoPage.Failure("not-found", "no answer for $uri")
        c.use {
            if (!it.moveToFirst()) throw TonuinoPage.Failure("not-found", "no document $uri")
            return row(it)
        }
    }

    @JavascriptInterface
    fun stat(id: String, tree: String, doc: String) {
        onWorker(id) { JSONObject().put("entry", entry(Uri.parse(tree), doc)) }
    }

    @JavascriptInterface
    fun list(id: String, tree: String, doc: String) {
        onWorker(id) {
            val uri = DocumentsContract.buildChildDocumentsUriUsingTree(Uri.parse(tree), doc)
            val out = JSONArray()
            val c = resolver.query(uri, COLUMNS, null, null, null) ?: throw TonuinoPage.Failure("not-found", "no list for $doc")
            c.use { while (it.moveToNext()) out.put(row(it)) }
            page.payload(id, out.toString())
        }
    }

    @JavascriptInterface
    fun read(id: String, tree: String, doc: String, start: Double, length: Double) {
        onWorker(id) {
            val want = length.toLong().coerceIn(0L, MAX_READ.toLong()).toInt()
            val bytes = ByteArray(want)
            var got = 0
            val pfd = resolver.openFileDescriptor(docUri(tree, doc), "r") ?: throw TonuinoPage.Failure("not-found", "cannot open $doc")
            pfd.use {
                FileInputStream(it.fileDescriptor).use { input ->
                    val channel = input.channel
                    try {
                        channel.position(start.toLong())
                    } catch (e: IOException) {
                        // Not seekable (a pipe of another provider): skip there by reading.
                        var skip = start.toLong()
                        while (skip > 0) {
                            val n = input.skip(skip)
                            if (n <= 0) break
                            skip -= n
                        }
                    }
                    val buf = ByteBuffer.wrap(bytes)
                    while (got < want) {
                        val n = channel.read(buf)
                        if (n <= 0) break
                        got += n
                    }
                }
            }
            page.payload(id, Base64.encodeToString(bytes, 0, got, Base64.NO_WRAP))
        }
    }

    @JavascriptInterface
    fun create(id: String, tree: String, parent: String, name: String, dir: Boolean) {
        onWorker(id) {
            // application/octet-stream: Android then adds no extension of its own to the name.
            val mime = if (dir) Document.MIME_TYPE_DIR else "application/octet-stream"
            val made = DocumentsContract.createDocument(resolver, docUri(tree, parent), mime, name) ?: throw TonuinoPage.Failure("io", "could not create $name")
            JSONObject().put("entry", entryOf(made))
        }
    }

    @JavascriptInterface
    fun remove(id: String, tree: String, doc: String) {
        onWorker(id) {
            if (!DocumentsContract.deleteDocument(resolver, docUri(tree, doc))) throw TonuinoPage.Failure("io", "could not delete $doc")
            JSONObject()
        }
    }

    @JavascriptInterface
    fun rename(id: String, tree: String, doc: String, name: String) {
        onWorker(id) {
            val before = docUri(tree, doc)
            // The id may change with the name (Android's own card provider builds ids from paths).
            val after = DocumentsContract.renameDocument(resolver, before, name) ?: before
            JSONObject().put("entry", entryOf(after))
        }
    }

    @JavascriptInterface
    fun move(id: String, tree: String, doc: String, fromParent: String, toParent: String) {
        onWorker(id) {
            val moved = try {
                DocumentsContract.moveDocument(resolver, docUri(tree, doc), docUri(tree, fromParent), docUri(tree, toParent))
            } catch (e: UnsupportedOperationException) {
                throw TonuinoPage.Failure("unsupported", e.message ?: "move")
            } catch (e: IllegalArgumentException) {
                // Older providers: "Unsupported call: android:moveDocument".
                if ((e.message ?: "").contains("Unsupported", ignoreCase = true)) throw TonuinoPage.Failure("unsupported", e.message ?: "move")
                throw e
            } ?: throw TonuinoPage.Failure("unsupported", "the provider did not move $doc")
            JSONObject().put("entry", entryOf(moved))
        }
    }

    /* ------------------------------------------------------------ writing */

    @JavascriptInterface
    fun openWrite(id: String, tree: String, doc: String) {
        onWorker(id) {
            val uri = docUri(tree, doc)
            // "rwt" empties the file; some providers know only "wt" or "w".
            var pfd: ParcelFileDescriptor? = null
            var last: Exception? = null
            for (mode in arrayOf("rwt", "wt", "w")) {
                try {
                    pfd = resolver.openFileDescriptor(uri, mode)
                    if (pfd != null) break
                } catch (e: IllegalArgumentException) {
                    last = e
                } catch (e: UnsupportedOperationException) {
                    last = e
                }
            }
            val fd = pfd ?: throw (last ?: TonuinoPage.Failure("not-found", "cannot open $doc"))
            val out = FileOutputStream(fd.fileDescriptor)
            try {
                // "w" does not empty the file on every Android version: make sure.
                out.channel.truncate(0)
                out.channel.position(0)
            } catch (e: IOException) {
                // A pipe: it starts empty anyway.
            }
            val token = "w" + tokens.incrementAndGet()
            writes[token] = Writer(fd, out, null)
            JSONObject().put("token", token)
        }
    }

    @JavascriptInterface
    fun openTemp(id: String) {
        onWorker(id) {
            val file = File.createTempFile(TEMP_PREFIX, ".tmp", activity.cacheDir)
            val token = "t" + tokens.incrementAndGet()
            writes[token] = Writer(null, FileOutputStream(file), file)
            JSONObject().put("token", token)
        }
    }

    @JavascriptInterface
    fun writeChunk(id: String, token: String, data: String) {
        onWorker(id) {
            val w = writes[token] ?: throw TonuinoPage.Failure("other", "no open file $token")
            w.out.write(Base64.decode(data, Base64.DEFAULT))
            JSONObject()
        }
    }

    @JavascriptInterface
    fun closeWrite(id: String, token: String) {
        onWorker(id) {
            val w = writes.remove(token) ?: throw TonuinoPage.Failure("other", "no open file $token")
            try {
                w.out.flush()
                try {
                    // Everything on the card before the page hears "done": the card may be pulled next.
                    w.out.fd.sync()
                } catch (e: SyncFailedException) {
                    // A pipe of another provider: it has written when it closes.
                }
            } finally {
                w.out.close()
                // The provider reports a failed write when its descriptor closes.
                w.pfd?.close()
            }
            if (w.temp != null) keepTemp(token, w.temp)
            JSONObject()
        }
    }

    @JavascriptInterface
    fun abortWrite(token: String) {
        try {
            worker.execute {
                val w = writes.remove(token) ?: return@execute
                try {
                    w.out.close()
                    w.pfd?.close()
                } catch (e: IOException) {
                    // Closed half written: the page removes a new file again.
                }
                w.temp?.delete()
            }
        } catch (e: RejectedExecutionException) {
            // close() was called.
        }
    }

    /** Finished temp files, by their token, for saveAs and print. */
    private val temps = ConcurrentHashMap<String, File>()

    private fun keepTemp(token: String, file: File) {
        temps[token] = file
    }

    /* ------------------------------------------------------------ space */

    @JavascriptInterface
    fun space(id: String, tree: String) {
        onWorker(id) {
            val doc = DocumentsContract.getTreeDocumentId(Uri.parse(tree))
            val root = doc.substringBefore(':')
            val out = JSONObject()
            // Android's own card provider: the drive is /storage/<root>, the phone's own storage is "primary".
            if (Uri.parse(tree).authority == "com.android.externalstorage.documents" && root.isNotEmpty()) {
                val dir = if (root == "primary") Environment.getExternalStorageDirectory() else File("/storage/$root")
                try {
                    val stat = StatFs(dir.path)
                    out.put("free", stat.availableBytes).put("total", stat.totalBytes)
                } catch (e: IllegalArgumentException) {
                    // Not reachable as a path: no numbers.
                }
            }
            out
        }
    }

    /* ------------------------------------------------------------ save and print */

    @JavascriptInterface
    fun saveAs(id: String, token: String, name: String, mime: String) {
        if (!TonuinoPage.validId(id)) return
        val file = temps.remove(token)
        if (file == null) {
            page.fail(id, "other", "no finished file $token")
            return
        }
        page.onMain {
            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(mime).putExtra(Intent.EXTRA_TITLE, name)
            try {
                activity.launchActivityForResult(intent) { result ->
                    val uri = result?.data?.data
                    if (result?.resultCode != Activity.RESULT_OK || uri == null) {
                        file.delete()
                        page.fail(id, "cancelled", "not saved")
                    } else {
                        onWorker(id) {
                            try {
                                val out = resolver.openOutputStream(uri, "wt") ?: throw TonuinoPage.Failure("io", "cannot write $uri")
                                out.use { o -> FileInputStream(file).use { it.copyTo(o) } }
                            } finally {
                                file.delete()
                            }
                            JSONObject()
                        }
                    }
                }
            } catch (e: Exception) {
                file.delete()
                page.fail(id, "unsupported", e.message ?: "no save dialog")
            }
        }
    }

    @JavascriptInterface
    fun print(id: String, token: String, name: String) {
        if (!TonuinoPage.validId(id)) return
        val file = temps.remove(token)
        if (file == null) {
            page.fail(id, "other", "no finished file $token")
            return
        }
        page.onMain {
            try {
                val manager = activity.getSystemService(Context.PRINT_SERVICE) as PrintManager
                manager.print(name.ifEmpty { "TonUINO Studio" }, PdfAdapter(file, name.ifEmpty { "TonUINO.pdf" }), PrintAttributes.Builder().build())
                page.done(id, JSONObject())
            } catch (e: Exception) {
                file.delete()
                page.fail(id, TonuinoPage.codeOf(e), e.message ?: "print")
            }
        }
    }

    /** Hands a finished PDF to Android's print dialog as it is; the dialog shows its pages. */
    private class PdfAdapter(private val file: File, private val name: String) : PrintDocumentAdapter() {
        override fun onLayout(oldAttributes: PrintAttributes?, newAttributes: PrintAttributes, cancellationSignal: CancellationSignal?, callback: LayoutResultCallback, extras: Bundle?) {
            if (cancellationSignal?.isCanceled == true) {
                callback.onLayoutCancelled()
                return
            }
            val info = PrintDocumentInfo.Builder(name)
                .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
                .setPageCount(PrintDocumentInfo.PAGE_COUNT_UNKNOWN)
                .build()
            callback.onLayoutFinished(info, oldAttributes == null || oldAttributes != newAttributes)
        }

        override fun onWrite(pages: Array<out PageRange>?, destination: ParcelFileDescriptor, cancellationSignal: CancellationSignal?, callback: WriteResultCallback) {
            try {
                FileInputStream(file).use { input -> FileOutputStream(destination.fileDescriptor).use { input.copyTo(it) } }
                if (cancellationSignal?.isCanceled == true) callback.onWriteCancelled() else callback.onWriteFinished(arrayOf(PageRange.ALL_PAGES))
            } catch (e: IOException) {
                callback.onWriteFailed(e.message)
            }
        }

        override fun onFinish() {
            file.delete()
        }
    }

    /* ------------------------------------------------------------ the rest */

    @JavascriptInterface
    fun take(id: String): String = page.take(id)

    @JavascriptInterface
    fun hasMicrophone(): Boolean = activity.packageManager.hasSystemFeature(PackageManager.FEATURE_MICROPHONE)

    @JavascriptInterface
    fun openAppSettings() {
        page.onMain {
            try {
                activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", activity.packageName, null)))
            } catch (e: Exception) {
                Log.w(LOG_TAG, "no settings page for the app", e)
            }
        }
    }

    /** From MainActivity.onDestroy. */
    fun close() {
        try {
            activity.unregisterReceiver(mediaReceiver)
        } catch (e: IllegalArgumentException) {
            // Not registered.
        }
        worker.shutdown()
        for (w in writes.values) {
            try {
                w.out.close()
                w.pfd?.close()
            } catch (e: IOException) {
                // Gone with the app.
            }
        }
        writes.clear()
    }

    /** Queues one card operation; its answer goes to the page. */
    private fun onWorker(id: String, op: () -> JSONObject) {
        if (!TonuinoPage.validId(id)) return
        try {
            worker.execute { page.answer(id, op) }
        } catch (e: RejectedExecutionException) {
            // close() was called.
        }
    }
}

/**
 * Registers a receiver for broadcasts of the system (a drive mounted, a USB
 * device plugged in). From Android 13 on a receiver must say whether other
 * apps may reach it; these only refresh what the page shows, so a broadcast
 * of another app could do no harm.
 */
fun registerSystemReceiver(context: Context, receiver: BroadcastReceiver, filter: IntentFilter) {
    if (Build.VERSION.SDK_INT >= 33) {
        context.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
    } else {
        @Suppress("UnspecifiedRegisterReceiverFlag")
        context.registerReceiver(receiver, filter)
    }
}
