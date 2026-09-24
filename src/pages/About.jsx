import { Link } from "react-router-dom";
import usePageMeta from "../lib/usePageMeta.js";
import AdSlot from "../components/AdSlot.jsx";
import Icon from "../components/Icon.jsx";

const VALUES = [
  { icon: "check", title: "Students first", desc: "Every feature comes from a real study problem, not a buzzword or busywork." },
  { icon: "lock", title: "Privacy by default", desc: "Your data stays yours. We do not sell it, and we do not keep the files you upload." },
  { icon: "bolt", title: "Always improving", desc: "New quiz types, languages and fixes ship most weeks. If something is off, it usually gets sorted quickly." },
];

export default function About() {
  usePageMeta(
    "About Revyy",
    "Revyy started as one student's tool for getting ready for exams: a fast way to test yourself on your own notes before the real thing."
  );
  return (
    <>
      <section className="hero" style={{ padding: "72px 0 32px" }}>
        <div className="container">
          <span className="eyebrow">About</span>
          <h1>Built by a student, for students</h1>
          <p className="hero-sub">Revyy started as a personal tool for getting ready for exams: a way to test yourself on your own notes before the real thing.</p>
        </div>
      </section>

      <section className="section">
        <div className="container prose">
          <p className="lead">
            Revyy came out of frustration with study methods that felt productive but never
            actually worked. I wanted something that could take any material and turn it into
            practice on the spot, so I built it.
          </p>
          <p>
            Rereading notes and highlighting textbooks felt like studying, but almost none of it
            stuck. What worked was testing myself. The catch was that writing good practice
            questions by hand took hours I did not have. Revyy closes that gap. Drop in your
            material and get a focused, accurate quiz in seconds, so your time goes on practising
            instead of preparing to practise.
          </p>

          <h2>Built on how memory actually works</h2>
          <p>
            Two things move information into long-term memory better than anything else: pulling
            it back out from scratch, and spacing that practice over time. Decades of research call
            these active recall and spaced repetition. Revyy is built around both. Instead of
            handing you notes to read again, it asks you questions, and the ones you miss come back
            on a widening schedule until you stop missing them. That is the whole loop, and it is
            the part most study apps skip.
          </p>

          <h2>Grounded in your material, not the internet</h2>
          <p>
            When you upload a page of notes, Revyy writes questions about what is on that page.
            If a fact is not in your material, it does not show up in your quiz, and every answer
            comes with a short explanation of why it is right. You can also flag a question that
            looks off, and it gets replaced. The goal is simple: you should be able to trust that
            practising here is practising the real thing, whether that is your own lecture notes or
            a full mock of the SAT, ACT or GRE.
          </p>
        </div>
      </section>

      <section className="section section-soft">
        <div className="container">
          <div className="section-head center">
            <div className="section-label">What we care about</div>
            <h2>Study time that goes further</h2>
            <p>The goal is simple: spend less time getting ready to study, and more time actually learning.</p>
          </div>
          <div className="grid grid-3">
            {VALUES.map((v) => (
              <div key={v.title} className="card">
                <div className="card-icon"><Icon name={v.icon} size={26} stroke={1.5} /></div>
                <h3>{v.title}</h3>
                <p>{v.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <AdSlot />

      <section className="section">
        <div className="container">
          <div className="section-head">
            <div className="section-label">The person behind it</div>
            <h2>Meet the maker</h2>
          </div>
          <div className="founder">
            <div className="avatar">
              <span>P</span>
              <img
                src="/plug.jpg"
                alt="Plug, the creator of Revyy"
                onError={(e) => {
                  console.error("[About] founder avatar failed to load:", e.currentTarget.src);
                  e.currentTarget.remove();   // reveal the "P" fallback behind it
                }}
              />
            </div>
            <div>
              <h3>Plug</h3>
              <div className="role">Creator and student</div>
              <p>
                I always wanted a way to test myself before sitting the real exam, so I built Revyy
                to do exactly that. I keep updating it and making sure it works well. If you have a
                suggestion or run into a problem, please reach out. I read everything.
              </p>
            </div>
          </div>
          <div style={{ textAlign: "center", marginTop: 40 }}>
            <Link to="/app" className="btn btn-primary btn-lg">Try Revyy free <Icon name="arrow" size={18} /></Link>
          </div>
        </div>
      </section>
    </>
  );
}
