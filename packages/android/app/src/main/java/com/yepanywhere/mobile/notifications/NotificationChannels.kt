package com.yepanywhere.mobile.notifications

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import com.yepanywhere.mobile.R

object NotificationChannels {
    fun ensureActivityChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return
        }
        val manager = context.getSystemService(NotificationManager::class.java)
        val channelId = context.getString(R.string.notification_channel_activity_id)
        val channel = NotificationChannel(
            channelId,
            context.getString(R.string.notification_channel_activity_name),
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            description = context.getString(R.string.notification_channel_activity_description)
        }
        manager.createNotificationChannel(channel)
    }
}
