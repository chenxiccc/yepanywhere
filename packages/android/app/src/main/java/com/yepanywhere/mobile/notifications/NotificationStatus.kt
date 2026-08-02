package com.yepanywhere.mobile.notifications

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import com.yepanywhere.mobile.BuildConfig
import com.yepanywhere.mobile.R
import com.yepanywhere.mobile.web.NativeHostOperationResult
import com.yepanywhere.mobile.web.NativeHostOperations
import org.json.JSONObject

enum class NotificationPermissionState(val wireValue: String) {
    GRANTED("granted"),
    NOT_REQUESTED("not_requested"),
    DENIED("denied"),
    NOT_REQUIRED("not_required"),
}

enum class NotificationChannelState(val wireValue: String) {
    ENABLED("enabled"),
    DISABLED("disabled"),
    NOT_SUPPORTED("not_supported"),
}

enum class BrokerInstallationState(val wireValue: String) {
    READY("ready"),
    UPDATE_PENDING("update_pending"),
    NOT_REGISTERED("not_registered"),
    UNAVAILABLE("unavailable"),
}

data class NotificationStatus(
    val firebaseConfigured: Boolean,
    val permission: NotificationPermissionState,
    val channel: NotificationChannelState,
    val installation: BrokerInstallationState,
    val notificationsEnabled: Boolean,
) {
    fun toJson(): JSONObject {
        return JSONObject()
            .put("firebase", if (firebaseConfigured) "configured" else "unavailable")
            .put("permission", permission.wireValue)
            .put("channel", channel.wireValue)
            .put("installation", installation.wireValue)
            .put("notificationsEnabled", notificationsEnabled)
    }
}

class NotificationStatusReader(
    context: Context,
    private val installationStorage: BrokerInstallationStorage,
) {
    private val context = context.applicationContext
    private val permissionHistory = context.getSharedPreferences(
        PERMISSION_PREFERENCES,
        Context.MODE_PRIVATE,
    )

    fun read(): NotificationStatus {
        NotificationChannels.ensureActivityChannel(context)
        val permission = readPermission()
        val channel = readChannel()
        val appNotificationsEnabled = NotificationManagerCompat.from(context)
            .areNotificationsEnabled()
        val installation = readInstallation()
        return NotificationStatus(
            firebaseConfigured = BuildConfig.FIREBASE_CONFIGURED,
            permission = permission,
            channel = channel,
            installation = installation,
            notificationsEnabled = appNotificationsEnabled &&
                permission != NotificationPermissionState.DENIED &&
                permission != NotificationPermissionState.NOT_REQUESTED &&
                channel != NotificationChannelState.DISABLED,
        )
    }

    @SuppressLint("ApplySharedPref", "UseKtx")
    fun markPermissionRequested() {
        // Persist before opening Android UI so denial is truthful after process death.
        check(
            permissionHistory.edit()
                .putBoolean(PERMISSION_REQUESTED_KEY, true)
                .commit(),
        ) { "Could not persist notification permission history" }
    }

    private fun readPermission(): NotificationPermissionState {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return NotificationPermissionState.NOT_REQUIRED
        }
        if (
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            return NotificationPermissionState.GRANTED
        }
        return if (permissionHistory.getBoolean(PERMISSION_REQUESTED_KEY, false)) {
            NotificationPermissionState.DENIED
        } else {
            NotificationPermissionState.NOT_REQUESTED
        }
    }

    private fun readChannel(): NotificationChannelState {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return NotificationChannelState.NOT_SUPPORTED
        }
        val manager = context.getSystemService(NotificationManager::class.java)
        val channel = manager.getNotificationChannel(
            context.getString(R.string.notification_channel_activity_id),
        )
        return if (channel?.importance == NotificationManager.IMPORTANCE_NONE) {
            NotificationChannelState.DISABLED
        } else {
            NotificationChannelState.ENABLED
        }
    }

    private fun readInstallation(): BrokerInstallationState {
        if (!BuildConfig.FIREBASE_CONFIGURED) {
            return BrokerInstallationState.UNAVAILABLE
        }
        val record = installationStorage.read()
            ?: return BrokerInstallationState.NOT_REGISTERED
        return if (record.targetCurrent) {
            BrokerInstallationState.READY
        } else {
            BrokerInstallationState.UPDATE_PENDING
        }
    }

    companion object {
        private const val PERMISSION_PREFERENCES = "ya_notification_permission_v1"
        private const val PERMISSION_REQUESTED_KEY = "requested"
    }
}

class NotificationNativeHostOperations(
    private val activity: ComponentActivity,
    private val statusReader: NotificationStatusReader,
    private val launchPermissionRequest: () -> Unit,
    private val now: () -> Long = SystemClock::elapsedRealtime,
) : NativeHostOperations {
    override val features = listOf(STATUS_METHOD, REQUEST_PERMISSION_METHOD)
    private var lastUserInteractionAt: Long? = null
    private var pendingPermissionRequest: ((NativeHostOperationResult) -> Unit)? = null

    fun recordUserInteraction() {
        lastUserInteractionAt = now()
    }

    fun onPermissionResult() {
        val completion = pendingPermissionRequest ?: return
        pendingPermissionRequest = null
        completion(NativeHostOperationResult.Success(statusReader.read().toJson()))
    }

    fun destroy() {
        pendingPermissionRequest = null
    }

    override fun invoke(
        method: String,
        params: JSONObject,
        complete: (NativeHostOperationResult) -> Unit,
    ) {
        if (params.length() != 0) {
            complete(
                NativeHostOperationResult.Error(
                    "invalid_params",
                    "$method takes no params",
                ),
            )
            return
        }
        when (method) {
            STATUS_METHOD -> complete(
                NativeHostOperationResult.Success(statusReader.read().toJson()),
            )
            REQUEST_PERMISSION_METHOD -> requestPermission(complete)
            else -> complete(
                NativeHostOperationResult.Error(
                    "unknown_method",
                    "Method is not supported",
                ),
            )
        }
    }

    private fun requestPermission(complete: (NativeHostOperationResult) -> Unit) {
        val current = statusReader.read()
        if (
            Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            current.permission == NotificationPermissionState.GRANTED
        ) {
            complete(NativeHostOperationResult.Success(current.toJson()))
            return
        }
        if (!activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
            complete(
                NativeHostOperationResult.Error(
                    "activity_not_ready",
                    "Notification permission requires a resumed activity",
                ),
            )
            return
        }
        val interactionAt = lastUserInteractionAt
        if (interactionAt == null || now() - interactionAt > USER_INTERACTION_WINDOW_MS) {
            complete(
                NativeHostOperationResult.Error(
                    "user_action_required",
                    "Notification permission requires recent user interaction",
                ),
            )
            return
        }
        if (pendingPermissionRequest != null) {
            complete(
                NativeHostOperationResult.Error(
                    "request_in_progress",
                    "Notification permission request is already active",
                ),
            )
            return
        }

        try {
            statusReader.markPermissionRequested()
            pendingPermissionRequest = complete
            launchPermissionRequest()
        } catch (_: RuntimeException) {
            pendingPermissionRequest = null
            complete(
                NativeHostOperationResult.Error(
                    "permission_request_failed",
                    "Android could not start the notification permission request",
                ),
            )
        }
    }

    companion object {
        const val STATUS_METHOD = "notifications.status"
        const val REQUEST_PERMISSION_METHOD = "notifications.requestPermission"
        private const val USER_INTERACTION_WINDOW_MS = 5_000L
    }
}
