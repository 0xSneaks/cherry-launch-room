import { handleMetadata } from "../server/metadata";

export function POST(request: Request): Promise<Response> {
  return handleMetadata(request, process.env);
}
