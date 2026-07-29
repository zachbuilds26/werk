import Logo from "./Logo"

export default function Footer() {
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer__bottom">
          <div className="footer__signoff">
            <Logo />
            <span>Browser-local workspace.</span>
          </div>
          <div className="footer__legal">
            <span className="footer__link">OKX.AI marketplace listing</span>
          </div>
        </div>
      </div>
    </footer>
  )
}
