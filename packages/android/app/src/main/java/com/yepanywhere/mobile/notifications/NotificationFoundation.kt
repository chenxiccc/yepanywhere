package com.yepanywhere.mobile.notifications

import android.content.Context
import com.yepanywhere.mobile.BuildConfig

object NotificationFoundation {
    fun installationStore(context: Context): BrokerInstallationStore {
        return BrokerInstallationStore(context)
    }

    fun installationCoordinator(context: Context): BrokerInstallationCoordinator {
        return BrokerInstallationCoordinator(
            installationStore(context),
            PushBrokerClient(BuildConfig.PUSH_BROKER_URL),
        )
    }

    fun needsFirebaseRegistration(context: Context): Boolean {
        if (!BuildConfig.FIREBASE_CONFIGURED) return false
        return installationStore(context).read()?.targetCurrent != true
    }
}
