import { disableTool } from "eve/tools";

// A subagent's sandbox wouldn't have the thread's credentials.
export default disableTool();
