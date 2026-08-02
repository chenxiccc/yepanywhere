package com.yepanywhere.mobile.security

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import com.yepanywhere.mobile.BuildConfig
import com.yepanywhere.mobile.profiles.YaPairedServerProfile
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import okio.ByteString.Companion.toByteString
import org.json.JSONArray
import org.json.JSONObject

fun interface YaSecurityClientDescriptorProvider {
    fun descriptor(profile: YaPairedServerProfile): JSONObject
}

class YaAndroidSecurityClientDescriptorProvider(context: Context) :
    YaSecurityClientDescriptorProvider {
    private val appContext = context.applicationContext

    override fun descriptor(profile: YaPairedServerProfile): JSONObject {
        val packageManager = appContext.packageManager
        val packageInfo = packageInfo(packageManager)
        val locales = appContext.resources.configuration.locales
        val languageTags = buildList {
            repeat(minOf(locales.size(), MAX_LANGUAGES)) { index ->
                locales[index].toLanguageTag().takeIf(String::isNotBlank)?.let(::add)
            }
        }
        val androidId = androidIdForSecurityAudit()
        return JSONObject()
            .put("installationId", profile.id)
            .put("deviceClass", deviceClass())
            .putOptional("manufacturer", Build.MANUFACTURER.bounded(128))
            .putOptional("brand", Build.BRAND.bounded(128))
            .putOptional("model", Build.MODEL.bounded(160))
            .putOptional("product", Build.PRODUCT.bounded(160))
            .putOptional("androidIdDigest", androidId?.digest())
            .put("osName", "Android")
            .put("osVersion", Build.VERSION.RELEASE.ifBlank { "unknown" }.take(128))
            .put("osApiLevel", Build.VERSION.SDK_INT)
            .putOptional("osBuildFingerprint", Build.FINGERPRINT.bounded(1024))
            .putOptional("securityPatch", Build.VERSION.SECURITY_PATCH.bounded(64))
            .put("appName", applicationLabel(packageManager).take(128))
            .put("appVersion", packageInfo.versionName.orEmpty().ifBlank { "unknown" }.take(128))
            .put("appBuild", packageInfo.longVersionCodeCompat())
            .put("packageName", appContext.packageName)
            .put("buildChannel", "${BuildConfig.FLAVOR}-${BuildConfig.BUILD_TYPE}".take(128))
            .putOptional("installerSource", installerSource(packageManager).bounded(256))
            .putOptional("signingCertificateDigest", signingCertificateDigest(packageInfo))
            .put("firstInstallAt", isoDate(packageInfo.firstInstallTime))
            .put("lastUpdateAt", isoDate(packageInfo.lastUpdateTime))
            .put("locale", Locale.getDefault().toLanguageTag().take(64))
            .put("languages", JSONArray(languageTags))
            .put("timeZone", TimeZone.getDefault().id.take(128))
            .put("supportedProofs", JSONArray().put("continuity-key"))
    }

    @Suppress("DEPRECATION")
    private fun packageInfo(packageManager: PackageManager): PackageInfo {
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            PackageManager.GET_SIGNING_CERTIFICATES
        } else {
            PackageManager.GET_SIGNATURES
        }
        return packageManager.getPackageInfo(appContext.packageName, flags)
    }

    @Suppress("DEPRECATION")
    private fun signingCertificateDigest(info: PackageInfo): String? {
        val bytes = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.signingInfo?.apkContentsSigners?.firstOrNull()?.toByteArray()
        } else {
            info.signatures?.firstOrNull()?.toByteArray()
        }
        return bytes?.digestBase64Url()
    }

    @Suppress("DEPRECATION")
    private fun installerSource(packageManager: PackageManager): String? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            runCatching {
                packageManager.getInstallSourceInfo(appContext.packageName).installingPackageName
            }.getOrNull()
        } else {
            packageManager.getInstallerPackageName(appContext.packageName)
        }
    }

    @Suppress("DEPRECATION")
    private fun PackageInfo.longVersionCodeCompat(): Long {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) longVersionCode else versionCode.toLong()
    }

    private fun applicationLabel(packageManager: PackageManager): String {
        return packageManager.getApplicationLabel(appContext.applicationInfo).toString()
            .ifBlank { "Yep Anywhere" }
    }

    // This per-signing-key/user/device value is hashed and shown only on the
    // user's own YA security audit. It is not used for ads or cross-app tracking.
    @SuppressLint("HardwareIds")
    private fun androidIdForSecurityAudit(): String? = Settings.Secure.getString(
        appContext.contentResolver,
        Settings.Secure.ANDROID_ID,
    )

    private fun deviceClass(): String {
        val virtual = Build.FINGERPRINT.startsWith("generic") ||
            Build.FINGERPRINT.contains("emulator", ignoreCase = true) ||
            Build.MODEL.contains("Emulator", ignoreCase = true)
        if (virtual) return "virtual"
        return if (appContext.resources.configuration.smallestScreenWidthDp >= 600) {
            "tablet"
        } else {
            "phone"
        }
    }

    private fun String?.bounded(max: Int): String? = this?.trim()?.takeIf(String::isNotEmpty)?.take(max)

    private fun String.digest(): String = MessageDigest.getInstance("SHA-256")
        .digest(toByteArray(Charsets.UTF_8))
        .toByteString()
        .base64Url()
        .trimEnd('=')

    private fun ByteArray.digestBase64Url(): String = MessageDigest.getInstance("SHA-256")
        .digest(this)
        .toByteString()
        .base64Url()
        .trimEnd('=')

    private fun isoDate(epochMs: Long): String {
        return SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }.format(Date(epochMs))
    }

    private fun JSONObject.putOptional(name: String, value: Any?): JSONObject {
        if (value != null) put(name, value)
        return this
    }

    companion object {
        private const val MAX_LANGUAGES = 16
    }
}
