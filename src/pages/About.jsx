import { Link } from "react-router-dom";

const VALUES = [
  { icon: "🎓", title: "Student First", desc: "Every feature is built around real study needs — not buzzwords or busywork." },
  { icon: "🔒", title: "Privacy Focused", desc: "Your data stays yours. We don't sell it, and we don't keep your uploaded files." },
  { icon: "⚡", title: "Constantly Improving", desc: "New quiz types, languages and improvements ship almost every week." },
];

export default function About() {
  return (
    <>
      <section className="hero" style={{ padding: "84px 0 90px" }}>
        <div className="container">
          <span className="eyebrow">About</span>
          <h1>Built by a student, for students</h1>
          <p className="hero-sub">Revyy started as a personal tool to survive exam season. Now it helps thousands study smarter.</p>
        </div>
      </section>

      <section className="section">
        <div className="container prose">
          <p className="lead">
            Revyy was built out of frustration with boring study methods. I wanted a
            tool that could take any material and instantly make it interactive — so I built it.
          </p>
          <p>
            Re-reading notes and highlighting textbooks felt productive but never stuck.
            What actually worked was testing myself — but making good practice questions by
            hand took hours I didn't have. Revyy closes that gap: drop in your material and
            get a focused, accurate quiz in seconds, so you can spend your time practising
            instead of preparing to practise.
          </p>
        </div>
      </section>

      <section className="section section-soft">
        <div className="container">
          <div className="section-head">
            <div className="section-label">Our mission</div>
            <h2>Studying that's faster, smarter, and actually enjoyable</h2>
            <p>Our mission is to make studying faster, smarter, and actually enjoyable for every student.</p>
          </div>
          <div className="grid grid-3">
            {VALUES.map((v) => (
              <div key={v.title} className="card">
                <div className="card-icon">{v.icon}</div>
                <h3>{v.title}</h3>
                <p>{v.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-head">
            <div className="section-label">The founder</div>
            <h2>Meet the maker</h2>
          </div>
          <div className="founder">
            <div className="avatar">R</div>
            <div>
              <h3>Revyy Founder</h3>
              <div className="role">Creator & Student</div>
              <p>
                A university student who got tired of inefficient studying and decided to do
                something about it. Revyy is built in the open, shaped by feedback from students
                who use it every day to prepare for real exams.
              </p>
            </div>
          </div>
          <div style={{ textAlign: "center", marginTop: 40 }}>
            <Link to="/signup" className="btn btn-primary btn-lg">Try Revyy Free →</Link>
          </div>
        </div>
      </section>
    </>
  );
}
