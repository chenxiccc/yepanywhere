package com.yepanywhere.mobile.notifications

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class BrokerInstallationStoreTest {
    @Test
    fun encryptsAndReloadsTheInstallationCapability() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val store = BrokerInstallationStore(
            context = context,
            preferenceName = "ya_push_installation_instrumentation",
            keyAlias = "ya_push_installation_instrumentation_key",
        )
        val record = BrokerInstallationRecord(
            installationId = "a".repeat(22),
            installationSecret = "b".repeat(43),
            targetDigest = "c".repeat(64),
            targetCurrent = true,
        )

        try {
            store.destroyTestState()
            store.write(record)

            val envelope = checkNotNull(store.encryptedEnvelopeForTest())
            assertFalse(envelope.contains(record.installationId))
            assertFalse(envelope.contains(record.installationSecret))
            assertFalse(envelope.contains(record.targetDigest))
            assertTrue(envelope.contains("ciphertext"))
            assertEquals(record, store.read())

            store.clear()
            assertNull(store.read())
        } finally {
            store.destroyTestState()
        }
    }
}
