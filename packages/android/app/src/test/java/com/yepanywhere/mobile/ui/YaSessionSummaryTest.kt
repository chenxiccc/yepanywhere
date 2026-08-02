package com.yepanywhere.mobile.ui

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class YaSessionSummaryTest {
    @Test
    fun parsesCompactSummaryAndPrefersCustomTitle() {
        val response = JSONObject().put(
            "sessions",
            JSONArray().put(
                JSONObject()
                    .put("id", "session-1")
                    .put("title", "Original title")
                    .put("customTitle", "Pinned title")
                    .put("projectName", "Yep Anywhere")
                    .put("provider", "codex")
                    .put("updatedAt", "2026-08-02T12:00:00.000Z")
                    .put("pendingInputType", "tool-approval")
                    .put("activity", "waiting-input")
                    .put("hasUnread", true)
                    .put("lastAgentText", "Waiting for approval"),
            ),
        )

        val summary = YaSessionSummary.parseResponse(response).single()

        assertEquals("session-1", summary.id)
        assertEquals("Pinned title", summary.title)
        assertEquals("Yep Anywhere", summary.projectName)
        assertEquals("codex", summary.provider)
        assertEquals("tool-approval", summary.pendingInputType)
        assertEquals("waiting-input", summary.activity)
        assertTrue(summary.hasUnread)
        assertEquals("Waiting for approval", summary.lastAgentText)
    }

    @Test
    fun acceptsNullableOptionalSummaryFields() {
        val response = JSONObject().put(
            "sessions",
            JSONArray().put(
                JSONObject()
                    .put("id", "session-2")
                    .put("title", JSONObject.NULL)
                    .put("projectName", "Project")
                    .put("provider", "claude")
                    .put("updatedAt", "2026-08-02T11:00:00.000Z"),
            ),
        )

        val summary = YaSessionSummary.parseResponse(response).single()

        assertNull(summary.title)
        assertNull(summary.pendingInputType)
        assertNull(summary.activity)
        assertNull(summary.lastAgentText)
        assertFalse(summary.hasUnread)
    }

    @Test
    fun rejectsAResponseWithoutTheSessionsContract() {
        assertThrows(IllegalArgumentException::class.java) {
            YaSessionSummary.parseResponse(JSONObject().put("items", JSONArray()))
        }
    }
}
