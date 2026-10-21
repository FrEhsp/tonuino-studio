// TonUINO Studio: the box over a USB cable at the phone (USB-OTG).
// scripts/build-android.sh copies this file next to the MainActivity that
// `tauri android init` generates and sets the package line to that package.

package app.tonuinostudio.desktop

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.hardware.usb.UsbRequest
import android.os.Build
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicInteger

/**
 * The page (src/platform/tauri/androidUsb.ts) talks to the box's USB-serial
 * chip through this object, added as `window.TonuinoUsb`. It only moves
 * bytes: which control transfers set up a CH340, CP210x, FTDI or CDC-ACM
 * chip is decided in the page (src/platform/tauri/usbChips.ts).
 *
 * From the page, answered at once:
 *   devices()          JSON of every USB device at the phone with its interfaces
 *   drop(handle)       forgets bytes read but not handed on; returns the new generation
 *   close(handle)      releases the device
 * From the page, answered later through TonuinoPage.done():
 *   permission(id, name)                                      {granted}
 *   open(id, name, interfaces, inEndpoint, outEndpoint, header)   {handle}
 *   control(id, handle, type, request, value, index, data, length) {data?}
 *   write(id, handle, data)                                   {}
 * To the page: event "usb-data" {handle, gen, data: [base64…]} with what the
 * chip sent, "usb-gone" {handle} when the device went away, "usb-devices" {}
 * when a device was plugged in or pulled.
 */
class TonuinoUsb(private val activity: WryActivity, private val page: TonuinoPage) {
    companion object {
        /** The name of the object in the page. */
        const val NAME = "TonuinoUsb"
        private const val LOG_TAG = "TonuinoUsb"
        private const val ACTION_PERMISSION = "tonuino.studio.USB_PERMISSION"
        private const val EXTRA_ID = "tonuino.id"
        private const val TIMEOUT_MS = 1000
        /** Largest bulk transfer in one go; older Android versions take no more. */
        private const val MAX_BULK = 16384
    }

    private val manager = activity.getSystemService(Context.USB_SERVICE) as UsbManager
    private val ports = ConcurrentHashMap<Int, Port>()
    private val handles = AtomicInteger()
    private val requestCodes = AtomicInteger()

    /** One opened device: its connection, a thread that reads, one that sends. */
    private inner class Port(
        val handle: Int,
        val device: UsbDevice,
        val connection: UsbDeviceConnection,
        val interfaces: List<UsbInterface>,
        val inEndpoint: UsbEndpoint,
        val outEndpoint: UsbEndpoint,
        /** Bytes at the start of every packet that are no data (FTDI: 2); packets no longer than this are not passed on. */
        val header: Int,
    ) {
        /** Control transfers and writes in the order the page sent them. */
        val io: ExecutorService = Executors.newSingleThreadExecutor()
        @Volatile var closing = false
        private val lock = Object()
        private val waiting = ArrayList<ByteArray>()
        private var scheduled = false
        private var gen = 0
        private var request: UsbRequest? = null
        private val reader = Thread({ readLoop() }, "TonuinoUsb-$handle")

        fun start() {
            reader.start()
        }

        /**
         * Reads the chip's bulk-in endpoint with a queued request, which never
         * loses bytes the way a bulk transfer that times out may.
         */
        private fun readLoop() {
            val size = (inEndpoint.maxPacketSize.coerceAtLeast(8) * 8).coerceAtMost(4096)
            val buffer = ByteBuffer.allocate(size)
            val req = UsbRequest()
            try {
                if (!req.initialize(connection, inEndpoint)) {
                    gone("cannot read")
                    return
                }
                request = req
                var empty = 0
                while (!closing) {
                    buffer.clear()
                    val queued = if (Build.VERSION.SDK_INT >= 26) {
                        req.queue(buffer)
                    } else {
                        @Suppress("DEPRECATION")
                        req.queue(buffer, size)
                    }
                    if (!queued) {
                        gone("queue failed")
                        return
                    }
                    val done = connection.requestWait()
                    if (closing) return
                    if (done == null) {
                        gone("device lost")
                        return
                    }
                    val n = buffer.position()
                    if (n > header) {
                        empty = 0
                        receive(buffer.array().copyOf(n))
                    } else if (n == 0 && ++empty > 100 && !attached()) {
                        // A device gone without notice answers with nothing, at once, again and again.
                        gone("no answers")
                        return
                    }
                }
            } catch (e: Exception) {
                if (!closing) gone(e.message ?: e.javaClass.simpleName)
            } finally {
                request = null
                try {
                    req.close()
                } catch (e: Exception) {
                    // Already closed with the connection.
                }
            }
        }

        private fun attached(): Boolean = manager.deviceList.containsKey(device.deviceName)

        /** Collects what arrived; one push to the page carries all of it. */
        private fun receive(bytes: ByteArray) {
            synchronized(lock) {
                waiting.add(bytes)
                if (scheduled) return
                scheduled = true
            }
            page.onMain { flush() }
        }

        private fun flush() {
            val data = JSONArray()
            val g: Int
            synchronized(lock) {
                scheduled = false
                for (b in waiting) data.put(Base64.encodeToString(b, Base64.NO_WRAP))
                waiting.clear()
                g = gen
            }
            if (data.length() > 0 && !closing) page.event("usb-data", JSONObject().put("handle", handle).put("gen", g).put("data", data))
        }

        fun drop(): Int = synchronized(lock) {
            waiting.clear()
            gen += 1
            gen
        }

        fun gone(why: String) {
            if (closing) return
            Log.i(LOG_TAG, "port $handle gone: $why")
            page.event("usb-gone", JSONObject().put("handle", handle).put("reason", why))
            close()
        }

        fun close() {
            if (closing && !ports.containsKey(handle)) return
            closing = true
            ports.remove(handle)
            try {
                request?.cancel()
            } catch (e: Exception) {
                // The reader ends anyway once the connection is closed.
            }
            io.shutdown()
            // Released on a thread of its own: the page must not wait for the reader to end.
            Thread {
                try {
                    reader.join(500)
                } catch (e: InterruptedException) {
                    // Go on and release.
                }
                for (itf in interfaces) {
                    try {
                        connection.releaseInterface(itf)
                    } catch (e: Exception) {
                        // Gone with the device.
                    }
                }
                connection.close()
            }.start()
        }
    }

    /* ------------------------------------------------------------ plugged in, pulled out, allowed */

    private val plugReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action == UsbManager.ACTION_USB_DEVICE_DETACHED) {
                val device = deviceExtra(intent)
                if (device != null) {
                    for (p in ports.values) if (p.device.deviceName == device.deviceName) p.gone("detached")
                }
            }
            page.event("usb-devices", JSONObject())
            // A card reader is a USB device too: the cards are looked for as soon as it is there.
            page.event("storage", JSONObject().put("action", intent.action ?: ""))
        }
    }

    /** Pending permission questions by request code: the id of the page's call. */
    private val asking = ConcurrentHashMap<Int, String>()

    private val permissionReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action != ACTION_PERMISSION) return
            val code = intent.getIntExtra(EXTRA_ID, -1)
            val id = asking.remove(code) ?: return
            val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
            page.done(id, JSONObject().put("granted", granted))
        }
    }

    init {
        registerSystemReceiver(
            activity,
            plugReceiver,
            IntentFilter().apply {
                addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
                addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
            },
        )
        // Our own broadcast (the PendingIntent below): no other app may send it.
        val own = IntentFilter(ACTION_PERMISSION)
        if (Build.VERSION.SDK_INT >= 33) {
            activity.registerReceiver(permissionReceiver, own, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            activity.registerReceiver(permissionReceiver, own)
        }
    }

    private fun deviceExtra(intent: Intent): UsbDevice? =
        if (Build.VERSION.SDK_INT >= 33) {
            intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(UsbManager.EXTRA_DEVICE)
        }

    /* ------------------------------------------------------------ the page */

    @JavascriptInterface
    fun devices(): String {
        val out = JSONArray()
        for (d in manager.deviceList.values) {
            val interfaces = JSONArray()
            for (i in 0 until d.interfaceCount) {
                val itf = d.getInterface(i)
                val endpoints = JSONArray()
                for (j in 0 until itf.endpointCount) {
                    val ep = itf.getEndpoint(j)
                    val type = when (ep.type) {
                        UsbConstants.USB_ENDPOINT_XFER_BULK -> "bulk"
                        UsbConstants.USB_ENDPOINT_XFER_INT -> "interrupt"
                        UsbConstants.USB_ENDPOINT_XFER_ISOC -> "iso"
                        else -> "control"
                    }
                    endpoints.put(
                        JSONObject()
                            .put("address", ep.address)
                            .put("type", type)
                            .put("dir", if (ep.direction == UsbConstants.USB_DIR_IN) "in" else "out")
                            .put("packetSize", ep.maxPacketSize),
                    )
                }
                interfaces.put(
                    JSONObject()
                        .put("id", itf.id)
                        .put("cls", itf.interfaceClass)
                        .put("subclass", itf.interfaceSubclass)
                        .put("protocol", itf.interfaceProtocol)
                        .put("endpoints", endpoints),
                )
            }
            val o = JSONObject()
                .put("name", d.deviceName)
                .put("vendorId", d.vendorId)
                .put("productId", d.productId)
                .put("permission", manager.hasPermission(d))
                .put("interfaces", interfaces)
            d.manufacturerName?.let { o.put("manufacturer", it) }
            d.productName?.let { o.put("product", it) }
            out.put(o)
        }
        return out.toString()
    }

    @JavascriptInterface
    fun permission(id: String, name: String) {
        if (!TonuinoPage.validId(id)) return
        val device = manager.deviceList[name]
        if (device == null) {
            page.fail(id, "not-found", "no device $name")
            return
        }
        if (manager.hasPermission(device)) {
            page.done(id, JSONObject().put("granted", true))
            return
        }
        val code = requestCodes.incrementAndGet()
        asking[code] = id
        // Mutable: Android adds the device and the answer to the intent. Explicit (our package), as Android 14 wants.
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
        val intent = Intent(ACTION_PERMISSION).setPackage(activity.packageName).putExtra(EXTRA_ID, code)
        page.onMain {
            try {
                manager.requestPermission(device, PendingIntent.getBroadcast(activity, code, intent, flags))
            } catch (e: Exception) {
                asking.remove(code)
                page.fail(id, TonuinoPage.codeOf(e), e.message ?: "permission")
            }
        }
    }

    @JavascriptInterface
    fun open(id: String, name: String, interfaces: String, inEndpoint: Int, outEndpoint: Int, header: Int) {
        if (!TonuinoPage.validId(id)) return
        page.answer(id) {
            val device = manager.deviceList[name] ?: throw TonuinoPage.Failure("not-found", "no device $name")
            if (!manager.hasPermission(device)) throw TonuinoPage.Failure("denied", "no permission for $name")
            val connection = manager.openDevice(device) ?: throw TonuinoPage.Failure("io", "cannot open $name")
            val wanted = interfaces.split(',').mapNotNull { it.trim().toIntOrNull() }
            val claimed = ArrayList<UsbInterface>()
            var inEp: UsbEndpoint? = null
            var outEp: UsbEndpoint? = null
            try {
                for (number in wanted) {
                    // The first alternate setting of that interface.
                    val itf = (0 until device.interfaceCount).map { device.getInterface(it) }.firstOrNull { it.id == number }
                        ?: throw TonuinoPage.Failure("not-found", "no interface $number")
                    if (!connection.claimInterface(itf, true)) throw TonuinoPage.Failure("io", "interface $number is busy")
                    claimed.add(itf)
                    for (j in 0 until itf.endpointCount) {
                        val ep = itf.getEndpoint(j)
                        if (ep.address == inEndpoint) inEp = ep
                        if (ep.address == outEndpoint) outEp = ep
                    }
                }
                if (inEp == null || outEp == null) throw TonuinoPage.Failure("not-found", "no endpoints $inEndpoint/$outEndpoint")
            } catch (e: Exception) {
                for (itf in claimed) connection.releaseInterface(itf)
                connection.close()
                throw e
            }
            val handle = handles.incrementAndGet()
            val port = Port(handle, device, connection, claimed, inEp!!, outEp!!, header.coerceAtLeast(0))
            ports[handle] = port
            port.start()
            JSONObject().put("handle", handle)
        }
    }

    @JavascriptInterface
    fun control(id: String, handle: Int, requestType: Int, request: Int, value: Int, index: Int, data: String, length: Int) {
        val port = ports[handle]
        if (!TonuinoPage.validId(id)) return
        if (port == null) {
            page.fail(id, "gone", "port $handle is closed")
            return
        }
        onIo(port, id) {
            val incoming = (requestType and UsbConstants.USB_DIR_IN) != 0
            val buffer = if (incoming) ByteArray(length.coerceIn(0, 4096)) else Base64.decode(data, Base64.DEFAULT)
            val n = port.connection.controlTransfer(requestType, request, value, index, buffer, buffer.size, TIMEOUT_MS)
            if (n < 0) throw TonuinoPage.Failure(if (attachedName(port)) "io" else "gone", "control transfer 0x${request.toString(16)} failed")
            val out = JSONObject()
            if (incoming) out.put("data", Base64.encodeToString(buffer, 0, n, Base64.NO_WRAP))
            out
        }
    }

    @JavascriptInterface
    fun write(id: String, handle: Int, data: String) {
        val port = ports[handle]
        if (!TonuinoPage.validId(id)) return
        if (port == null) {
            page.fail(id, "gone", "port $handle is closed")
            return
        }
        onIo(port, id) {
            val bytes = Base64.decode(data, Base64.DEFAULT)
            var at = 0
            while (at < bytes.size) {
                val n = port.connection.bulkTransfer(port.outEndpoint, bytes, at, minOf(MAX_BULK, bytes.size - at), TIMEOUT_MS * 2)
                if (n < 0) throw TonuinoPage.Failure(if (attachedName(port)) "io" else "gone", "write failed after $at of ${bytes.size} bytes")
                at += n
            }
            JSONObject()
        }
    }

    @JavascriptInterface
    fun drop(handle: Int): Int = ports[handle]?.drop() ?: 0

    @JavascriptInterface
    fun close(handle: Int) {
        ports[handle]?.close()
    }

    private fun attachedName(port: Port): Boolean = manager.deviceList.containsKey(port.device.deviceName)

    private fun onIo(port: Port, id: String, op: () -> JSONObject) {
        try {
            port.io.execute { page.answer(id, op) }
        } catch (e: RejectedExecutionException) {
            page.fail(id, "gone", "port ${port.handle} is closed")
        }
    }

    /** From MainActivity.onDestroy: every device is let go. */
    fun closeAll() {
        for (p in ports.values) p.close()
        for (r in arrayOf(plugReceiver, permissionReceiver)) {
            try {
                activity.unregisterReceiver(r)
            } catch (e: IllegalArgumentException) {
                // Not registered.
            }
        }
    }
}
