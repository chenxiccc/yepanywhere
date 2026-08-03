package com.yepanywhere.mobile.profiles

import org.json.JSONArray
import org.json.JSONObject

internal object YaIncludedServerPolicy {
    fun encode(profileIds: Set<String>): String {
        profileIds.forEach { requireUuid(it, "included profile id") }
        return JSONObject()
            .put("version", VERSION)
            .put("profileIds", JSONArray(profileIds.sorted()))
            .toString()
    }

    /** A missing or malformed policy safely preserves the default-all upgrade. */
    fun decode(raw: String?, knownProfileIds: Set<String>): Set<String> {
        if (raw == null) return knownProfileIds
        return runCatching {
            val root = JSONObject(raw)
            check(root.length() == 2 && root.getInt("version") == VERSION)
            val ids = root.getJSONArray("profileIds")
            buildSet {
                repeat(ids.length()) { index ->
                    val id = ids.getString(index)
                    requireUuid(id, "included profile id")
                    if (id in knownProfileIds) add(id)
                }
            }
        }.getOrElse { knownProfileIds }
    }

    private const val VERSION = 1
}

data class YaPairedServerListState(
    val profiles: List<YaPairedServerProfile>,
    val includedProfileIds: Set<String>,
    val selectedProfileId: String?,
)
