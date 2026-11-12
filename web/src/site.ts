import { supabase } from "./supabase";

// "Request a demo" on the public website: saves the request to demo_requests.
// Anyone can add a request; only the CIS Tech team can read them (in Supabase).
const form = document.getElementById("demo-form") as HTMLFormElement | null;
const status = document.getElementById("d-status")!;
const val = (id: string) => (document.getElementById(id) as HTMLInputElement).value.trim();

function show(text: string, kind: "ok" | "err" | "") {
  status.textContent = text;
  status.className = "form-status" + (kind ? " " + kind : "");
}

form?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (val("d-website")) return; // filled only by bots
  const name = val("d-name"), business = val("d-business"), email = val("d-email");
  if (!name || !business || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return show("Please add your name, agency name and a valid email.", "err");
  }
  const button = document.getElementById("d-submit") as HTMLButtonElement;
  button.disabled = true;
  show("Sending...", "");
  const { error } = await supabase.from("demo_requests").insert({
    name, business, email,
    phone: val("d-phone") || null,
    agency_type: val("d-type") || null,
    agency_size: val("d-size") || null,
    message: val("d-message") || null,
  });
  button.disabled = false;
  if (error) return show("That didn't go through. Please try again in a minute.", "err");
  form.reset();
  show("Thank you. We'll reach out within one business day to book your demo.", "ok");
});
