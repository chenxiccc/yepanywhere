package com.yepanywhere.mobile.notifications

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BrokerInstallationCoordinatorTest {
    @Test
    fun createsOneInstallationAndKeepsTheFidOutOfStorage() {
        val storage = FakeStorage()
        val broker = FakeBroker()
        val coordinator = BrokerInstallationCoordinator(storage, broker)

        assertEquals(
            InstallationRegistrationOutcome.READY,
            coordinator.registerTarget("firebase-installation-id"),
        )

        assertEquals(listOf("firebase-installation-id"), broker.createdTargets)
        val record = checkNotNull(storage.record)
        assertEquals(CREDENTIALS.installationId, record.installationId)
        assertEquals(CREDENTIALS.installationSecret, record.installationSecret)
        assertNotEquals("firebase-installation-id", record.targetDigest)
        assertEquals(64, record.targetDigest.length)
        assertTrue(record.targetCurrent)

        assertEquals(
            InstallationRegistrationOutcome.UNCHANGED,
            coordinator.registerTarget("firebase-installation-id"),
        )
        assertEquals(1, broker.createdTargets.size)
        assertTrue(broker.replacedTargets.isEmpty())
    }

    @Test
    fun replacesAChangedTargetAndMarksTransientFailurePending() {
        val storage = FakeStorage(record = readyRecord())
        val broker = FakeBroker()
        val coordinator = BrokerInstallationCoordinator(storage, broker)

        broker.replaceResult = ReplaceInstallationTargetResult.FAILED
        assertEquals(
            InstallationRegistrationOutcome.DEFERRED,
            coordinator.registerTarget("replacement-fid"),
        )
        assertFalse(checkNotNull(storage.record).targetCurrent)
        assertEquals(listOf("replacement-fid"), broker.replacedTargets)

        broker.replaceResult = ReplaceInstallationTargetResult.UPDATED
        assertEquals(
            InstallationRegistrationOutcome.READY,
            coordinator.registerTarget("replacement-fid"),
        )
        assertTrue(checkNotNull(storage.record).targetCurrent)
        assertEquals(2, broker.replacedTargets.size)
    }

    @Test
    fun replacesAMissingBrokerCapabilityWithOneFreshInstallation() {
        val storage = FakeStorage(record = readyRecord())
        val broker = FakeBroker().apply {
            replaceResult = ReplaceInstallationTargetResult.NOT_FOUND
        }
        val coordinator = BrokerInstallationCoordinator(storage, broker)

        assertEquals(
            InstallationRegistrationOutcome.READY,
            coordinator.registerTarget("replacement-fid"),
        )

        assertEquals(listOf("replacement-fid"), broker.replacedTargets)
        assertEquals(listOf("replacement-fid"), broker.createdTargets)
        assertTrue(checkNotNull(storage.record).targetCurrent)
    }

    @Test
    fun boundsInvalidTargetsAndCleansUpAfterStorageFailure() {
        val storage = FakeStorage()
        val broker = FakeBroker()
        val coordinator = BrokerInstallationCoordinator(storage, broker)

        assertEquals(
            InstallationRegistrationOutcome.INVALID_TARGET,
            coordinator.registerTarget(" bad-target "),
        )
        assertTrue(broker.createdTargets.isEmpty())

        storage.failWrites = true
        assertEquals(
            InstallationRegistrationOutcome.STORAGE_FAILURE,
            coordinator.registerTarget("valid-target"),
        )
        assertEquals(listOf(CREDENTIALS), broker.deletedCredentials)
    }

    private class FakeStorage(
        var record: BrokerInstallationRecord? = null,
    ) : BrokerInstallationStorage {
        var failWrites = false

        override fun read(): BrokerInstallationRecord? = record

        override fun write(record: BrokerInstallationRecord) {
            if (failWrites) error("storage failed")
            this.record = record
        }

        override fun clear() {
            record = null
        }
    }

    private class FakeBroker : PushBrokerApi {
        val createdTargets = mutableListOf<String>()
        val replacedTargets = mutableListOf<String>()
        val deletedCredentials = mutableListOf<BrokerInstallationCredentials>()
        var replaceResult = ReplaceInstallationTargetResult.UPDATED

        override fun createInstallation(fid: String): CreateInstallationResult {
            createdTargets += fid
            return CreateInstallationResult.Created(CREDENTIALS)
        }

        override fun replaceInstallationTarget(
            credentials: BrokerInstallationCredentials,
            fid: String,
        ): ReplaceInstallationTargetResult {
            assertEquals(CREDENTIALS, credentials)
            replacedTargets += fid
            return replaceResult
        }

        override fun deleteInstallation(credentials: BrokerInstallationCredentials) {
            deletedCredentials += credentials
        }
    }

    companion object {
        private val CREDENTIALS = BrokerInstallationCredentials(
            installationId = "a".repeat(22),
            installationSecret = "b".repeat(43),
        )

        private fun readyRecord(): BrokerInstallationRecord {
            return BrokerInstallationRecord(
                installationId = CREDENTIALS.installationId,
                installationSecret = CREDENTIALS.installationSecret,
                targetDigest = "c".repeat(64),
                targetCurrent = true,
            )
        }
    }
}
