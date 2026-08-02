package com.yepanywhere.mobile.profiles

import androidx.datastore.preferences.preferencesDataStoreFile
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.yepanywhere.mobile.connection.YaResumeCredential
import com.yepanywhere.mobile.connection.YaSecureTransportCrypto
import java.util.UUID
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class YaPairedServerStoreTest {
    @Test
    fun encryptsReloadsAndForgetsPairedServerResumeState() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val suffix = UUID.randomUUID().toString()
        val fileName = "ya_paired_server_test_$suffix"
        val keyAlias = "ya_paired_server_test_key_$suffix"
        val dataFile = context.preferencesDataStoreFile(fileName)
        val cipher = AndroidKeystoreResumeCredentialCipher(keyAlias)
        val baseKey = ByteArray(YaSecureTransportCrypto.KEY_BYTES) { (it + 1).toByte() }
        val route = YaServerRoute.direct("wss://desktop.example.test/api/ws")
        val profile = YaPairedServerProfile.create(
            label = "Studio",
            username = "remote-user",
            route = route,
            nowEpochMs = 1_800_000_000_000,
        )
        val stored = YaStoredResumeCredential(
            credential = YaResumeCredential(
                username = profile.username,
                sessionId = "resume-session-secret",
                baseKey = baseKey,
                resumeProtocolVersion = YaSecureTransportCrypto.RESUME_PROTOCOL_VERSION,
            ),
            establishedAtEpochMs = profile.createdAtEpochMs,
            lastResumedAtEpochMs = null,
        )
        baseKey.fill(0)

        val store = YaPairedServerStore.create(context, fileName, keyAlias)
        var reloadedStore: YaPairedServerStore? = null
        try {
            store.upsert(profile, stored, select = true)

            assertEquals(profile.id, store.selectedProfileId.first())
            assertEquals(profile, store.profiles.first().single())
            assertEquals(stored, store.snapshot(profile.id)?.resumeCredential)
            val rawStorage = dataFile.readBytes().toString(Charsets.ISO_8859_1)
            assertFalse(rawStorage.contains(stored.credential.sessionId))
            assertFalse(
                rawStorage.contains(
                    YaSecureTransportCrypto.encodeBase64(stored.credential.copyBaseKey()),
                ),
            )

            store.close()
            delay(100)

            reloadedStore = YaPairedServerStore.create(context, fileName, keyAlias)
            assertEquals(stored, reloadedStore.snapshot(profile.id)?.resumeCredential)
            reloadedStore.clearCredential(profile.id)
            assertNull(reloadedStore.snapshot(profile.id)?.resumeCredential)
            reloadedStore.upsert(profile, stored)
            assertEquals(stored, reloadedStore.snapshot(profile.id)?.resumeCredential)
            reloadedStore.upsert(profile.copy(username = "different-user"))
            assertNull(reloadedStore.snapshot(profile.id)?.resumeCredential)
            reloadedStore.forget(profile.id)
            assertTrue(reloadedStore.snapshots().isEmpty())
            assertNull(reloadedStore.selectedProfileId.first())
        } finally {
            store.close()
            reloadedStore?.close()
            delay(100)
            dataFile.delete()
            cipher.destroyTestKey()
        }
    }

    @Test
    fun bindsEncryptedCredentialToItsLocalProfileId() {
        val suffix = UUID.randomUUID().toString()
        val cipher = AndroidKeystoreResumeCredentialCipher("ya_paired_aad_test_$suffix")
        val firstProfile = UUID.randomUUID().toString()
        val secondProfile = UUID.randomUUID().toString()
        val plaintext = "resume credential".toByteArray()
        try {
            val envelope = cipher.encrypt(firstProfile, plaintext)
            assertEquals(
                plaintext.toList(),
                cipher.decrypt(firstProfile, envelope)?.toList(),
            )
            assertNull(cipher.decrypt(secondProfile, envelope))
        } finally {
            plaintext.fill(0)
            cipher.destroyTestKey()
        }
    }
}
