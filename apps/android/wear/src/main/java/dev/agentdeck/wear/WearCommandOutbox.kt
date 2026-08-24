package dev.agentdeck.wear

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

data class QueuedWearCommand(val id: String, val payload: String)

class WearCommandOutbox(context: Context) : SQLiteOpenHelper(context, "agent-deck-outbox.db", null, 1) {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE command_outbox (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit

    fun put(id: String, payload: String) {
        writableDatabase.insertWithOnConflict("command_outbox", null, ContentValues().apply {
            put("id", id); put("payload", payload); put("created_at", System.currentTimeMillis())
        }, SQLiteDatabase.CONFLICT_REPLACE)
    }

    fun remove(id: String) { writableDatabase.delete("command_outbox", "id = ?", arrayOf(id)) }

    fun all(): List<QueuedWearCommand> = readableDatabase.query(
        "command_outbox", arrayOf("id", "payload"), null, null, null, null, "created_at ASC",
    ).use { cursor ->
        buildList {
            while (cursor.moveToNext()) add(QueuedWearCommand(cursor.getString(0), cursor.getString(1)))
        }
    }
}
