const dns = require("node:dns");
if (dns.setDefaultResultOrder) dns.setDefaultResultOrder("ipv4first");
const { execSync } = require("node:child_process");
const bcrypt = require("bcryptjs");
const { getPrisma } = require("../src/db");
const { deployProcedures } = require("./deploy-procedures");

const roles = [
    "System Administrator",
    "Facility/Maintenance Staff",
    "Faculty / Student Organization Representative",
];

const reservationStatuses = ["Pending", "Approved", "Rejected", "Cancelled"];

const facilityTypes = [
    "Classroom",
    "Lecture Hall",
    "Laboratory",
    "Computer Laboratory",
    "Conference Room",
    "Auditorium",
    "Gymnasium",
    "Study Room",
];

const equipmentCategories = [
    "Audio Visual Equipment",
    "Computer Equipment",
    "Laboratory Equipment",
    "Sports Equipment",
    "Furniture",
    "Maintenance Tools",
];

async function seed() {
    const prisma = getPrisma();
    // 0. Ensure schema tables exist (auto push if not yet created)
    try {
        await prisma.role.findFirst({ select: { roleId: true } });
    } catch {
        console.log(
            "Database schema not found. Initializing schema with prisma db push...",
        );
        execSync(
            "npx prisma db push --config prisma7.config.ts --skip-generate",
            {
                stdio: "inherit",
                env: process.env,
                shell: true,
            },
        );
    }

    // 0.1 Ensure im101_private stored procedures, functions, and triggers exist
    try {
        await deployProcedures();
    } catch (procError) {
        console.warn(
            "Notice: Stored procedure deployment warning:",
            procError.message || procError,
        );
    }
    console.log("Seeding database lookups...");

    // 1. Roles
    for (const roleName of roles) {
        await prisma.role.upsert({
            where: { roleName },
            create: { roleName },
            update: {},
        });
    }
    console.log(`- Upserted ${roles.length} roles.`);

    // 2. Reservation Statuses
    for (const statusName of reservationStatuses) {
        await prisma.reservationStatus.upsert({
            where: { statusName },
            create: { statusName },
            update: {},
        });
    }
    console.log(
        `- Upserted ${reservationStatuses.length} reservation statuses.`,
    );

    // 3. Facility Types
    for (const typeName of facilityTypes) {
        await prisma.facilityType.upsert({
            where: { typeName },
            create: { typeName },
            update: {},
        });
    }
    console.log(`- Upserted ${facilityTypes.length} facility types.`);

    // 4. Equipment Categories
    for (const categoryName of equipmentCategories) {
        await prisma.equipmentCategory.upsert({
            where: { categoryName },
            create: { categoryName },
            update: {},
        });
    }
    console.log(
        `- Upserted ${equipmentCategories.length} equipment categories.`,
    );

    // 5. Initial Accounts (Admin, Staff, Representative)
    const accounts = [
        {
            email: (process.env.PROVISION_ADMIN_EMAIL || "admin@campus.edu")
                .trim()
                .toLowerCase(),
            password:
                process.env.PROVISION_ADMIN_PASSWORD ||
                "AdminSecurePassword2026!",
            fname: process.env.PROVISION_ADMIN_FIRST_NAME?.trim() || "System",
            lname:
                process.env.PROVISION_ADMIN_LAST_NAME?.trim() ||
                "Administrator",
            roleName: roles[0],
        },
        {
            email: (process.env.PROVISION_STAFF_EMAIL || "staff@campus.edu")
                .trim()
                .toLowerCase(),
            password:
                process.env.PROVISION_STAFF_PASSWORD ||
                "StaffSecurePassword2026!",
            fname: process.env.PROVISION_STAFF_FIRST_NAME?.trim() || "Alex",
            lname: process.env.PROVISION_STAFF_LAST_NAME?.trim() || "Morgan",
            roleName: roles[1],
        },
        {
            email: (process.env.PROVISION_USER_EMAIL || "student@campus.edu")
                .trim()
                .toLowerCase(),
            password:
                process.env.PROVISION_USER_PASSWORD ||
                "StudentSecurePassword2026!",
            fname: process.env.PROVISION_USER_FIRST_NAME?.trim() || "Jordan",
            lname: process.env.PROVISION_USER_LAST_NAME?.trim() || "Lee",
            roleName: roles[2],
        },
    ];

    for (const acc of accounts) {
        if (acc.password.length < 15 || Buffer.byteLength(acc.password) > 72) {
            console.warn(
                `Skipping ${acc.roleName} creation: password must be between 15 and 72 characters.`,
            );
            continue;
        }
        const role = await prisma.role.findUnique({
            where: { roleName: acc.roleName },
            select: { roleId: true },
        });
        if (role) {
            const existing = await prisma.user.findUnique({
                where: { email: acc.email },
                select: { userId: true },
            });
            if (!existing) {
                const passwordHash = await bcrypt.hash(acc.password, 12);
                await prisma.user.create({
                    data: {
                        email: acc.email,
                        fname: acc.fname,
                        lname: acc.lname,
                        passwordHash,
                        roleId: role.roleId,
                        isActive: true,
                    },
                });
                console.log(
                    `- Created initial account [${acc.roleName}]: ${acc.email}`,
                );
            } else {
                console.log(`- Account already exists: ${acc.email}`);
            }
        }
    }

    // 6. Initial Buildings
    const defaultBuildings = [
        {
            buildingName: "Main Academic Building",
            floorCount: 4,
            locationNote: "Central Campus",
        },
        {
            buildingName: "Science & Engineering Hall",
            floorCount: 3,
            locationNote: "West Campus",
        },
        {
            buildingName: "Student Activity Center",
            floorCount: 2,
            locationNote: "East Campus",
        },
    ];

    const seededBuildings = {};
    for (const b of defaultBuildings) {
        const row = await prisma.building.upsert({
            where: { buildingName: b.buildingName },
            create: b,
            update: {},
        });
        seededBuildings[b.buildingName] = row.buildingId;
    }
    console.log(`- Seeded ${defaultBuildings.length} default buildings.`);

    // 7. Initial Facilities
    const defaultFacilities = [
        {
            facilityName: "Lecture Hall 101",
            buildingName: "Main Academic Building",
            typeName: "Lecture Hall",
            floorNumber: 1,
            capacity: 120,
            status: "Available",
        },
        {
            facilityName: "Computer Laboratory 201",
            buildingName: "Science & Engineering Hall",
            typeName: "Computer Laboratory",
            floorNumber: 2,
            capacity: 40,
            status: "Available",
        },
        {
            facilityName: "Conference Room 102",
            buildingName: "Main Academic Building",
            typeName: "Conference Room",
            floorNumber: 1,
            capacity: 25,
            status: "Available",
        },
        {
            facilityName: "Student Gymnasium",
            buildingName: "Student Activity Center",
            typeName: "Gymnasium",
            floorNumber: 1,
            capacity: 500,
            status: "Available",
        },
    ];

    const seededFacilities = {};
    for (const f of defaultFacilities) {
        const buildingId = seededBuildings[f.buildingName];
        const type = await prisma.facilityType.findUnique({
            where: { typeName: f.typeName },
            select: { facilityTypeId: true },
        });
        if (buildingId && type) {
            const row = await prisma.facility.upsert({
                where: {
                    buildingId_facilityName_floorNumber: {
                        buildingId,
                        facilityName: f.facilityName,
                        floorNumber: f.floorNumber,
                    },
                },
                create: {
                    facilityName: f.facilityName,
                    buildingId,
                    facilityTypeId: type.facilityTypeId,
                    floorNumber: f.floorNumber,
                    capacity: f.capacity,
                    status: f.status,
                },
                update: {},
            });
            seededFacilities[f.facilityName] = row.facilityId;
        }
    }
    console.log(`- Seeded ${defaultFacilities.length} default facilities.`);

    // 8. Initial Equipment
    const defaultEquipment = [
        {
            equipmentName: "Multimedia Projector 4K",
            categoryName: "Audio Visual Equipment",
            homeFacilityName: "Lecture Hall 101",
            serialNumber: "PRJ-4K-001",
            totalQuantity: 6,
            availableQuantity: 6,
            conditionStatus: "Good",
        },
        {
            equipmentName: "Dell Precision Workstation",
            categoryName: "Computer Equipment",
            homeFacilityName: "Computer Laboratory 201",
            serialNumber: "WS-DP-001",
            totalQuantity: 15,
            availableQuantity: 15,
            conditionStatus: "Good",
        },
        {
            equipmentName: "Wireless PA System",
            categoryName: "Audio Visual Equipment",
            homeFacilityName: "Student Gymnasium",
            serialNumber: "PA-WL-001",
            totalQuantity: 4,
            availableQuantity: 4,
            conditionStatus: "Good",
        },
        {
            equipmentName: "Digital Oscilloscope",
            categoryName: "Laboratory Equipment",
            homeFacilityName: "Computer Laboratory 201",
            serialNumber: "OSC-DG-001",
            totalQuantity: 8,
            availableQuantity: 8,
            conditionStatus: "Good",
        },
    ];

    for (const eq of defaultEquipment) {
        const cat = await prisma.equipmentCategory.findUnique({
            where: { categoryName: eq.categoryName },
            select: { categoryId: true },
        });
        const homeFacilityId = seededFacilities[eq.homeFacilityName] || null;
        if (cat) {
            await prisma.equipment.upsert({
                where: { serialNumber: eq.serialNumber },
                create: {
                    equipmentName: eq.equipmentName,
                    categoryId: cat.categoryId,
                    homeFacilityId,
                    serialNumber: eq.serialNumber,
                    totalQuantity: eq.totalQuantity,
                    availableQuantity: eq.availableQuantity,
                    conditionStatus: eq.conditionStatus,
                },
                update: {},
            });
        }
    }
    console.log(`- Seeded ${defaultEquipment.length} default equipment items.`);

    console.log("Database seeding completed successfully.");
}

seed()
    .catch((error) => {
        console.error("Database seeding failed:", error.message || error);
        process.exitCode = 1;
    })
    .finally(async () => {
        try {
            const prisma = getPrisma();
            await prisma.$disconnect();
        } catch {
            // Ignore disconnect error during process exit
        }
    });
