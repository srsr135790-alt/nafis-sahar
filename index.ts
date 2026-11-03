import { Server } from "colyseus";
import { NafisRoom } from "./NafisRoom";

const server = new Server();
// الغرفة تُحدَّد برمز الغرفة الذي تنشئه المعلمة: client.joinOrCreate("nafis", { code, nickname, avatar })
server.define("nafis", NafisRoom).filterBy(["code"]);
server.listen(Number(process.env.PORT) || 2567);
console.log("Nafis server ready");
