-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "roles" (
    "role_id" SERIAL NOT NULL,
    "role_name" VARCHAR(50) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("role_id")
);

-- CreateTable
CREATE TABLE "facility_types" (
    "facility_type_id" SERIAL NOT NULL,
    "type_name" VARCHAR(50) NOT NULL,

    CONSTRAINT "facility_types_pkey" PRIMARY KEY ("facility_type_id")
);

-- CreateTable
CREATE TABLE "equipment_categories" (
    "category_id" SERIAL NOT NULL,
    "category_name" VARCHAR(50) NOT NULL,

    CONSTRAINT "equipment_categories_pkey" PRIMARY KEY ("category_id")
);

-- CreateTable
CREATE TABLE "reservation_status" (
    "status_id" SERIAL NOT NULL,
    "status_name" VARCHAR(30) NOT NULL,

    CONSTRAINT "reservation_status_pkey" PRIMARY KEY ("status_id")
);

-- CreateTable
CREATE TABLE "users" (
    "user_id" SERIAL NOT NULL,
    "role_id" INTEGER NOT NULL,
    "fname" VARCHAR(60) NOT NULL,
    "lname" VARCHAR(60) NOT NULL,
    "email" VARCHAR(150) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "id_number" VARCHAR(30),
    "contact_number" VARCHAR(20),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "buildings" (
    "building_id" SERIAL NOT NULL,
    "building_name" VARCHAR(100) NOT NULL,
    "floor_count" SMALLINT NOT NULL,
    "location_note" VARCHAR(150),

    CONSTRAINT "buildings_pkey" PRIMARY KEY ("building_id")
);

-- CreateTable
CREATE TABLE "facilities" (
    "facility_id" SERIAL NOT NULL,
    "building_id" INTEGER NOT NULL,
    "facility_type_id" INTEGER NOT NULL,
    "facility_name" VARCHAR(100) NOT NULL,
    "floor_number" SMALLINT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'Available',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "facilities_pkey" PRIMARY KEY ("facility_id")
);

-- CreateTable
CREATE TABLE "equipment" (
    "equipment_id" SERIAL NOT NULL,
    "category_id" INTEGER NOT NULL,
    "home_facility_id" INTEGER,
    "equipment_name" VARCHAR(100) NOT NULL,
    "serial_number" VARCHAR(60),
    "total_quantity" INTEGER NOT NULL,
    "available_quantity" INTEGER NOT NULL,
    "condition_status" VARCHAR(20) NOT NULL DEFAULT 'Good',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "equipment_pkey" PRIMARY KEY ("equipment_id")
);

-- CreateTable
CREATE TABLE "reservations" (
    "reservation_id" SERIAL NOT NULL,
    "facility_id" INTEGER NOT NULL,
    "requested_by" INTEGER NOT NULL,
    "approved_by" INTEGER,
    "status_id" INTEGER NOT NULL,
    "purpose" VARCHAR(255) NOT NULL,
    "start_datetime" TIMESTAMPTZ(6) NOT NULL,
    "end_datetime" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("reservation_id")
);

-- CreateTable
CREATE TABLE "reservation_equipment" (
    "reservation_id" INTEGER NOT NULL,
    "equipment_id" INTEGER NOT NULL,
    "quantity_requested" INTEGER NOT NULL,
    "quantity_approved" INTEGER,
    "condition_at_issue" VARCHAR(20),
    "condition_at_return" VARCHAR(20),

    CONSTRAINT "reservation_equipment_pkey" PRIMARY KEY ("reservation_id","equipment_id")
);

-- CreateTable
CREATE TABLE "equipment_loans" (
    "loan_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "approved_by" INTEGER,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "due_date" TIMESTAMPTZ(6) NOT NULL,
    "return_date" TIMESTAMPTZ(6),
    "loan_status" VARCHAR(15) NOT NULL DEFAULT 'Pending',

    CONSTRAINT "equipment_loans_pkey" PRIMARY KEY ("loan_id")
);

-- CreateTable
CREATE TABLE "loan_items" (
    "loan_id" INTEGER NOT NULL,
    "equipment_id" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "condition_out" VARCHAR(20),
    "condition_in" VARCHAR(20),

    CONSTRAINT "loan_items_pkey" PRIMARY KEY ("loan_id","equipment_id")
);

-- CreateTable
CREATE TABLE "facility_staff_assignments" (
    "assignment_id" SERIAL NOT NULL,
    "facility_id" INTEGER NOT NULL,
    "staff_id" INTEGER NOT NULL,
    "assigned_role" VARCHAR(30) NOT NULL DEFAULT 'Custodian',
    "shift" VARCHAR(15),
    "assigned_date" DATE NOT NULL DEFAULT CURRENT_DATE,
    "unassigned_date" DATE,

    CONSTRAINT "facility_staff_assignments_pkey" PRIMARY KEY ("assignment_id")
);

-- CreateTable
CREATE TABLE "maintenance_requests" (
    "request_id" SERIAL NOT NULL,
    "facility_id" INTEGER,
    "equipment_id" INTEGER,
    "reported_by" INTEGER,
    "assigned_staff_id" INTEGER,
    "description" TEXT NOT NULL,
    "priority" VARCHAR(10) NOT NULL DEFAULT 'Normal',
    "status" VARCHAR(20) NOT NULL DEFAULT 'Open',
    "reported_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "maintenance_requests_pkey" PRIMARY KEY ("request_id")
);

-- CreateTable
CREATE TABLE "maintenance_logs" (
    "log_id" SERIAL NOT NULL,
    "request_id" INTEGER NOT NULL,
    "staff_id" INTEGER,
    "action_taken" TEXT NOT NULL,
    "logged_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "maintenance_logs_pkey" PRIMARY KEY ("log_id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "log_id" BIGSERIAL NOT NULL,
    "table_name" VARCHAR(50) NOT NULL,
    "record_id" INTEGER NOT NULL,
    "action_type" VARCHAR(10) NOT NULL,
    "changed_by" INTEGER,
    "old_value" JSONB,
    "new_value" JSONB,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("log_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "roles_role_name_key" ON "roles"("role_name");

-- CreateIndex
CREATE UNIQUE INDEX "facility_types_type_name_key" ON "facility_types"("type_name");

-- CreateIndex
CREATE UNIQUE INDEX "equipment_categories_category_name_key" ON "equipment_categories"("category_name");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_status_status_name_key" ON "reservation_status"("status_name");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_id_number_key" ON "users"("id_number");

-- CreateIndex
CREATE UNIQUE INDEX "buildings_building_name_key" ON "buildings"("building_name");

-- CreateIndex
CREATE UNIQUE INDEX "facilities_building_id_facility_name_floor_number_key" ON "facilities"("building_id", "facility_name", "floor_number");

-- CreateIndex
CREATE UNIQUE INDEX "equipment_serial_number_key" ON "equipment"("serial_number");

-- CreateIndex
CREATE INDEX "reservations_facility_id_start_datetime_end_datetime_idx" ON "reservations"("facility_id", "start_datetime", "end_datetime");

-- CreateIndex
CREATE INDEX "reservations_requested_by_idx" ON "reservations"("requested_by");

-- CreateIndex
CREATE INDEX "loan_items_equipment_id_idx" ON "loan_items"("equipment_id");

-- CreateIndex
CREATE INDEX "facility_staff_assignments_facility_id_staff_id_idx" ON "facility_staff_assignments"("facility_id", "staff_id");

-- CreateIndex
CREATE INDEX "maintenance_requests_status_idx" ON "maintenance_requests"("status");

-- CreateIndex
CREATE INDEX "audit_logs_table_name_record_id_idx" ON "audit_logs"("table_name", "record_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("role_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_building_id_fkey" FOREIGN KEY ("building_id") REFERENCES "buildings"("building_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_facility_type_id_fkey" FOREIGN KEY ("facility_type_id") REFERENCES "facility_types"("facility_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "equipment_categories"("category_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_home_facility_id_fkey" FOREIGN KEY ("home_facility_id") REFERENCES "facilities"("facility_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facilities"("facility_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "reservation_status"("status_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "reservation_equipment" ADD CONSTRAINT "reservation_equipment_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("reservation_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "reservation_equipment" ADD CONSTRAINT "reservation_equipment_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "equipment"("equipment_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "equipment_loans" ADD CONSTRAINT "equipment_loans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "equipment_loans" ADD CONSTRAINT "equipment_loans_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "loan_items" ADD CONSTRAINT "loan_items_loan_id_fkey" FOREIGN KEY ("loan_id") REFERENCES "equipment_loans"("loan_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "loan_items" ADD CONSTRAINT "loan_items_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "equipment"("equipment_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "facility_staff_assignments" ADD CONSTRAINT "facility_staff_assignments_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facilities"("facility_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "facility_staff_assignments" ADD CONSTRAINT "facility_staff_assignments_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "users"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maintenance_requests" ADD CONSTRAINT "maintenance_requests_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facilities"("facility_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maintenance_requests" ADD CONSTRAINT "maintenance_requests_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "equipment"("equipment_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maintenance_requests" ADD CONSTRAINT "maintenance_requests_reported_by_fkey" FOREIGN KEY ("reported_by") REFERENCES "users"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maintenance_requests" ADD CONSTRAINT "maintenance_requests_assigned_staff_id_fkey" FOREIGN KEY ("assigned_staff_id") REFERENCES "users"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maintenance_logs" ADD CONSTRAINT "maintenance_logs_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "maintenance_requests"("request_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maintenance_logs" ADD CONSTRAINT "maintenance_logs_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "users"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "users"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
