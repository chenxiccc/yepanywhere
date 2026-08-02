package com.yepanywhere.mobile.notifications

import java.security.MessageDigest

enum class InstallationRegistrationOutcome {
    READY,
    UNCHANGED,
    DEFERRED,
    INVALID_TARGET,
    STORAGE_FAILURE,
}

class BrokerInstallationCoordinator(
    private val storage: BrokerInstallationStorage,
    private val broker: PushBrokerApi,
) {
    @Synchronized
    fun registerTarget(fid: String): InstallationRegistrationOutcome {
        if (!isValidFid(fid)) return InstallationRegistrationOutcome.INVALID_TARGET
        return try {
            val digest = digestTarget(fid)
            val current = storage.read()
                ?: return createInstallation(fid, digest)
            if (current.targetCurrent && current.targetDigest == digest) {
                return InstallationRegistrationOutcome.UNCHANGED
            }

            if (current.targetCurrent) {
                storage.write(current.copy(targetCurrent = false))
            }
            val credentials = BrokerInstallationCredentials(
                current.installationId,
                current.installationSecret,
            )
            when (broker.replaceInstallationTarget(credentials, fid)) {
                ReplaceInstallationTargetResult.UPDATED -> {
                    storage.write(
                        current.copy(targetDigest = digest, targetCurrent = true),
                    )
                    InstallationRegistrationOutcome.READY
                }
                ReplaceInstallationTargetResult.NOT_FOUND -> {
                    storage.clear()
                    createInstallation(fid, digest)
                }
                ReplaceInstallationTargetResult.FAILED -> {
                    InstallationRegistrationOutcome.DEFERRED
                }
            }
        } catch (_: Exception) {
            InstallationRegistrationOutcome.STORAGE_FAILURE
        }
    }

    private fun createInstallation(
        fid: String,
        targetDigest: String,
    ): InstallationRegistrationOutcome {
        return when (val created = broker.createInstallation(fid)) {
            is CreateInstallationResult.Created -> {
                try {
                    storage.write(
                        BrokerInstallationRecord(
                            installationId = created.credentials.installationId,
                            installationSecret = created.credentials.installationSecret,
                            targetDigest = targetDigest,
                            targetCurrent = true,
                        ),
                    )
                    InstallationRegistrationOutcome.READY
                } catch (_: Exception) {
                    broker.deleteInstallation(created.credentials)
                    InstallationRegistrationOutcome.STORAGE_FAILURE
                }
            }
            CreateInstallationResult.Failed -> InstallationRegistrationOutcome.DEFERRED
        }
    }

    companion object {
        private fun isValidFid(fid: String): Boolean {
            return fid.isNotEmpty() &&
                fid.length <= 4096 &&
                fid.trim() == fid &&
                fid.none { it.code in 0..31 || it.code == 127 }
        }

        private fun digestTarget(fid: String): String {
            val digits = "0123456789abcdef"
            return buildString(64) {
                for (byte in MessageDigest.getInstance("SHA-256").digest(
                    fid.toByteArray(Charsets.UTF_8),
                )) {
                    val value = byte.toInt() and 0xff
                    append(digits[value ushr 4])
                    append(digits[value and 0x0f])
                }
            }
        }
    }
}
