package com.yepanywhere.mobile.notifications

import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.yepanywhere.mobile.BuildConfig

class YepFirebaseMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        if (BuildConfig.DEBUG) {
            Log.i(TAG, "FCM registration token refreshed")
        }
    }

    override fun onRegistered(installationId: String) {
        if (BuildConfig.DEBUG) {
            Log.i(TAG, "FCM registered installation ID: $installationId")
        }
    }

    override fun onUnregistered(installationId: String) {
        if (BuildConfig.DEBUG) {
            Log.i(TAG, "FCM unregistered installation ID: $installationId")
        }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        if (BuildConfig.DEBUG) {
            Log.i(
                TAG,
                "FCM message received: dataKeys=${message.data.keys.sorted()} " +
                    "hasNotification=${message.notification != null}",
            )
        }
    }

    companion object {
        private const val TAG = "YepAnywhereFCM"
    }
}
