import { handleRpc } from "../server/rpc";

export function POST(request: Request): Promise<Response> {
  return handleRpc(request, process.env);
}
