//agola age teke takbe
const fs = require("fs");

// JSON file এর correct name path
const jsonData = fs.readFileSync("./serverKeyConveter.json", "utf-8");

const base64String = Buffer.from(jsonData, "utf-8").toString("base64");
console.log(base64String);
