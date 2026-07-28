import Logo from "./Logo"

export default function Footer() {
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer__bottom">
          <div className="footer__signoff">
            <Logo />
            <span>One request, useful work outputs.</span>
          </div>
          <div className="footer__legal">
            <span className="footer__link">Live on OKX.AI as an agent</span>
          </div>
        </div>
      </div>
    </footer>
  )
}
