import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    supabase: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY),
    browserUse: Boolean(process.env.BROWSER_USE_API_KEY),
    base44: Boolean(process.env.BASE44_AGENT_URL && process.env.BASE44_API_KEY && process.env.BASE44_AGENT_ID),
    whatsapp: Boolean(process.env.NEXT_PUBLIC_BASE44_APP_ID && process.env.NEXT_PUBLIC_BASE44_AGENT_NAME),
    playwright: process.env.PLAYWRIGHT_CLI_ENABLED === "true",
    evaluator: Boolean(process.env.AGENT_EVALUATOR_URL && process.env.AGENT_EVALUATOR_API_KEY),
  });
}
