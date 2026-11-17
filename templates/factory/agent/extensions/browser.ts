import browser from "@agent-browser/eve";

// A browser in the sandbox (headless Chrome through agent-browser), for trying changes and showing them.
// One named session, so the ui-demo skill's recorder (agent-browser --session browser record …) records
// the same tab the browser tools drive.
export default browser({ session: "browser" });
