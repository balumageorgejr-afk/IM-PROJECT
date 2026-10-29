const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
    validateDisposableConfig,
} = require("../scripts/test-reservations-postgres");

test("integration harness accepts only its explicitly managed disposable loopback configuration", () => {
    const config = {
        host: "127.0.0.1",
        port: 15432,
        database: "im101_reservation_disposable_" + "a".repeat(24),
        user: "im101_test_admin",
        password: "b".repeat(64),
        managedCluster: true,
    };
    assert.equal(validateDisposableConfig(config), config);
    for (const patch of [
        { host: "localhost" },
        { host: "db.fixture.supabase.co" },
        { host: "192.0.2.1" },
        { database: "postgres" },
        { database: "production" },
        { port: 543.5 },
        { user: "postgres" },
        { managedCluster: false },
        { password: "production-credential" },
        {
            connectionString:
                "postgresql://fixture:synthetic@remote.example.test/production",
        },
        { options: "-c timezone=UTC" },
    ])
        assert.throws(
            () => validateDisposableConfig({ ...config, ...patch }),
            /ISOLATED_DATABASE_CONFIGURATION_REFUSED/,
        );
    assert.throws(
        () => validateDisposableConfig({}),
        /ISOLATED_DATABASE_CONFIGURATION_REFUSED/,
    );
});

test("additive audit artifact uses explicit snapshots, fixed errors, local actor and restricted ownership", () => {
    const sql = fs.readFileSync(
        path.join(
            "prisma/migrations/20261026010000_reservation_audit/migration.sql",
        ),
        "utf8",
    );
    assert.match(
        sql,
        /AFTER INSERT OR UPDATE OR DELETE ON public\.reservations\s+FOR EACH ROW/,
    );
    assert.match(
        sql,
        /SECURITY DEFINER\s+SET search_path = pg_catalog, pg_temp/,
    );
    assert.match(sql, /current_setting\('im101.actor_id', true\)/);
    assert.match(sql, /OWNER TO im101_reservation_audit_writer/);
    assert.match(sql, /REVOKE ALL ON FUNCTION .* FROM PUBLIC/);
    assert.ok(
        !/to_jsonb|row_to_json|EXECUTE\s+format|CREATE ROLE|ALTER TABLE|DROP TABLE/i.test(
            sql,
        ),
    );
    const snapshots = [...sql.matchAll(/jsonb_build_object\(([\s\S]*?)\);/g)];
    assert.equal(snapshots.length, 2);
    for (const [, snapshot] of snapshots) {
        const names = [...snapshot.matchAll(/'(\w+)'\s*,/g)].map(
            (match) => match[1],
        );
        assert.deepEqual(
            names.filter((name) => name !== "UTC"),
            [
                "reservation_id",
                "facility_id",
                "requested_by",
                "approved_by",
                "status_id",
                "start_datetime",
                "end_datetime",
                "created_at",
            ],
        );
        assert.ok(!/purpose|email|password|token/.test(snapshot));
    }
});
