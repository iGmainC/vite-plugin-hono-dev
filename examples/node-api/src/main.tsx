import React from "react";
import { createRoot } from "react-dom/client";

function App() {
  const [message, setMessage] = React.useState("loading...");

  React.useEffect(() => {
    fetch("/api/ping")
      .then((res) => res.json())
      .then((data) => setMessage(JSON.stringify(data)))
      .catch((error) => setMessage(String(error)));
  }, []);

  return (
    <main>
      <h1>Node API Dual-Port Example</h1>
      <pre>{message}</pre>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
