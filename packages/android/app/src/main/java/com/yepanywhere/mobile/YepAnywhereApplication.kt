package com.yepanywhere.mobile

import android.app.Application
import android.util.Log
import com.google.firebase.messaging.FirebaseMessaging
import com.yepanywhere.mobile.notifications.NotificationChannels
import com.yepanywhere.mobile.notifications.NotificationFoundation

class YepAnywhereApplication : Application() {
    lateinit var nativeRuntime: YaNativeRuntime
        private set

    override fun onCreate() {
        super.onCreate()
        nativeRuntime = YaNativeRuntime(this)
        NotificationChannels.ensureActivityChannel(this)
        if (!NotificationFoundation.needsFirebaseRegistration(this)) {
            return
        }
        try {
            FirebaseMessaging.getInstance().register().addOnFailureListener {
                if (BuildConfig.DEBUG) {
                    Log.i(TAG, "FCM registration deferred")
                }
            }
        } catch (_: RuntimeException) {
            if (BuildConfig.DEBUG) {
                Log.i(TAG, "FCM registration unavailable")
            }
        }
    }

    companion object {
        private const val TAG = "YepAnywhereFCM"
    }
}
