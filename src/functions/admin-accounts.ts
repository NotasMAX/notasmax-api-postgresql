import { app } from "@azure/functions";
import { createAdminAccountHandlers } from "../auth/admin-account-handler";

const handlers = createAdminAccountHandlers();

app.http("adminStudentsList", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "v1/admin/students",
  handler: handlers.listStudents
});

app.http("adminStudentsCreate", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "v1/admin/students",
  handler: handlers.createStudent
});

app.http("adminStudentDetail", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "v1/admin/students/{studentId}",
  handler: handlers.getStudent
});

app.http("adminStudentUpdate", {
  methods: ["PATCH"],
  authLevel: "anonymous",
  route: "v1/admin/students/{studentId}",
  handler: handlers.updateStudent
});

app.http("adminStudentDelete", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "v1/admin/students/{studentId}",
  handler: handlers.deleteStudent
});

app.http("adminTeachersList", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "v1/admin/teachers",
  handler: handlers.listTeachers
});

app.http("adminTeachersCreate", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "v1/admin/teachers",
  handler: handlers.createTeacher
});

app.http("adminTeacherDetail", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "v1/admin/teachers/{teacherId}",
  handler: handlers.getTeacher
});

app.http("adminTeacherUpdate", {
  methods: ["PATCH"],
  authLevel: "anonymous",
  route: "v1/admin/teachers/{teacherId}",
  handler: handlers.updateTeacher
});

app.http("adminTeacherDelete", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "v1/admin/teachers/{teacherId}",
  handler: handlers.deleteTeacher
});

app.http("adminAdministratorsList", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "v1/admin/administrators",
  handler: handlers.listAdministrators
});

app.http("adminAdministratorsCreate", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "v1/admin/administrators",
  handler: handlers.createAdministrator
});

app.http("adminAdministratorDetail", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "v1/admin/administrators/{administratorId}",
  handler: handlers.getAdministrator
});

app.http("adminAdministratorUpdate", {
  methods: ["PATCH"],
  authLevel: "anonymous",
  route: "v1/admin/administrators/{administratorId}",
  handler: handlers.updateAdministrator
});

app.http("adminAdministratorDelete", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "v1/admin/administrators/{administratorId}",
  handler: handlers.deleteAdministrator
});
