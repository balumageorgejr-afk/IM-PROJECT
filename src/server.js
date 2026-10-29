const { createApp } = require("./app");
try {
    const app = createApp();
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () =>
        console.log(`Server running on http://localhost:${PORT}`),
    ).on("error", () => {
        console.error("Server could not start. Check the listening port.");
        process.exitCode = 1;
    });
} catch {
    console.error(
        "Server configuration invalid. Check JWT_SECRET and local environment.",
    );
    process.exitCode = 1;
}
